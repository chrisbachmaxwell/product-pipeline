import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * BulkPhotoEditor — fullscreen modal for batch resize/rotate with live preview.
 *
 * Uses a portal to render outside the normal DOM tree, ensuring proper
 * z-index and centering regardless of parent layout.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
// Use 2000px for export — PhotoRoom upscales to 4000x4000 with outputSize param
// Keeps upload size manageable (~2-4MB vs 10-15MB at 4000px)
const CANVAS_SIZE = 2000;
const PREVIEW_SIZE = 280;
/** Build proxy URL for GCS, trying cutout variant first */
function proxyGcs(gcsPath) {
    return `/api/images/proxy?url=${encodeURIComponent(gcsPath)}`;
}
/** Extract GCS base path + index from a draft image URL */
function extractCutoutUrl(url) {
    // Match patterns like: .../processed/10130105925923_0.png (possibly with signature)
    const match = url.match(/processed\/(\d{10,})_(\d+)\.png/);
    if (!match)
        return null;
    return `https://storage.googleapis.com/pictureline-product-photos/processed/${match[1]}_${match[2]}_cutout.png`;
}
/** Try loading an image from a list of URLs (first success wins) */
function loadImageWithFallbacks(urls) {
    return new Promise((resolve, reject) => {
        let idx = 0;
        const tryNext = () => {
            if (idx >= urls.length) {
                reject(new Error('All image sources failed'));
                return;
            }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => { idx++; tryNext(); };
            img.src = urls[idx];
        };
        tryNext();
    });
}
/** Load the cutout version of an image (transparent bg, no shadow/watermark) */
async function loadCutoutImage(draftUrl) {
    const urls = [];
    // Try cutout first (transparent, product only)
    const cutoutGcs = extractCutoutUrl(draftUrl);
    if (cutoutGcs) {
        urls.push(proxyGcs(cutoutGcs));
        // Then try the clean version (white bg, no watermark)
        urls.push(proxyGcs(cutoutGcs.replace('_cutout.png', '_clean.png')));
    }
    // Fallback: proxy the original URL
    if (draftUrl.includes('storage.googleapis.com')) {
        urls.push(proxyGcs(draftUrl));
    }
    else {
        urls.push(draftUrl);
    }
    return loadImageWithFallbacks(urls);
}
function renderToCanvas(img, scale, rotation, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    // Checkerboard for preview
    if (size <= PREVIEW_SIZE * 2) {
        const sq = 12;
        for (let y = 0; y < size; y += sq) {
            for (let x = 0; x < size; x += sq) {
                ctx.fillStyle = ((x / sq + y / sq) % 2 === 0) ? '#f5f5f5' : '#eaeaea';
                ctx.fillRect(x, y, sq, sq);
            }
        }
    }
    else {
        ctx.clearRect(0, 0, size, size);
    }
    const imgAspect = img.width / img.height;
    let drawW, drawH;
    if (imgAspect > 1) {
        drawW = size * 0.8;
        drawH = drawW / imgAspect;
    }
    else {
        drawH = size * 0.8;
        drawW = drawH * imgAspect;
    }
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    return canvas;
}
// ── Live preview card ──────────────────────────────────────────────────
const PreviewCard = ({ url, index, scale, rotation }) => {
    const canvasRef = useRef(null);
    const imgRef = useRef(null);
    useEffect(() => {
        let cancelled = false;
        loadCutoutImage(url).then((img) => {
            if (cancelled)
                return;
            imgRef.current = img;
            const preview = renderToCanvas(img, scale, rotation, PREVIEW_SIZE);
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx && canvasRef.current) {
                ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
                ctx.drawImage(preview, 0, 0);
            }
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [url]);
    useEffect(() => {
        const img = imgRef.current;
        if (!img)
            return;
        const preview = renderToCanvas(img, scale, rotation, PREVIEW_SIZE);
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx && canvasRef.current) {
            ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
            ctx.drawImage(preview, 0, 0);
        }
    }, [scale, rotation]);
    return (_jsxs("div", { style: {
            borderRadius: '10px',
            overflow: 'hidden',
            border: '2px solid #e3e5e7',
            background: '#f9fafb',
            position: 'relative',
        }, children: [_jsx("canvas", { ref: canvasRef, width: PREVIEW_SIZE, height: PREVIEW_SIZE, style: { display: 'block', width: '100%', aspectRatio: '1' } }), _jsxs("div", { style: {
                    position: 'absolute',
                    bottom: '6px',
                    left: '6px',
                    background: 'rgba(0,0,0,0.6)',
                    color: '#fff',
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: '4px',
                }, children: ["#", index + 1] })] }));
};
// ── Main modal (portaled to document.body) ─────────────────────────────
const BulkPhotoEditor = ({ selectedIndices, allImageUrls, draftId, onSave, onCancel, }) => {
    const [scale, setScale] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState(null);
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);
    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape' && !processing)
                onCancel();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onCancel, processing]);
    const handleApply = useCallback(async () => {
        setProcessing(true);
        setError(null);
        setProgress(0);
        try {
            const updatedImages = [...allImageUrls];
            for (let i = 0; i < selectedIndices.length; i++) {
                const idx = selectedIndices[i];
                const img = await loadCutoutImage(allImageUrls[idx]);
                const canvas = renderToCanvas(img, scale, rotation, CANVAS_SIZE);
                // Use PNG to preserve transparency (cutout has transparent bg)
                const blob = await new Promise((resolve, reject) => {
                    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
                });
                console.log(`[BulkEdit] Photo ${idx}: blob size = ${(blob.size / 1024).toFixed(0)}KB`);
                const formData = new FormData();
                formData.append('image', blob, `bulk-${draftId}-${idx}-${Date.now()}.png`);
                formData.append('draftId', String(draftId || 'unknown'));
                formData.append('imageIndex', String(idx));
                formData.append('scale', String(scale));
                let data;
                try {
                    const res = await fetch('/api/images/reprocess-edited', {
                        method: 'POST',
                        body: formData,
                    });
                    if (!res.ok) {
                        const d = await res.json().catch(() => ({ error: 'Reprocess failed' }));
                        throw new Error(d.error || `Failed on photo ${idx + 1}`);
                    }
                    data = await res.json();
                }
                catch (fetchErr) {
                    // Network error or timeout
                    const msg = fetchErr instanceof Error ? fetchErr.message : 'Network error';
                    throw new Error(`Photo ${idx + 1}: ${msg}. The image may be too large or the server timed out.`);
                }
                // Prefer GCS URL over data URL (data URLs are too large for draft storage)
                updatedImages[idx] = data.gcsUrl || data.dataUrl;
                setProgress(i + 1);
            }
            // Don't PUT here — let the parent handle saving via its own mutation
            // (avoids double-PUT race condition)
            onSave(updatedImages);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Bulk edit failed');
        }
        finally {
            setProcessing(false);
        }
    }, [selectedIndices, allImageUrls, scale, rotation, draftId, onSave]);
    const noChange = scale === 1 && rotation === 0;
    const presetScales = [
        { label: '60%', value: 0.6 },
        { label: '75%', value: 0.75 },
        { label: '85%', value: 0.85 },
        { label: '100%', value: 1 },
        { label: '115%', value: 1.15 },
        { label: '130%', value: 1.3 },
    ];
    const modal = (_jsx("div", { onClick: (e) => { if (e.target === e.currentTarget && !processing)
            onCancel(); }, style: {
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 2147483646,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
        }, children: _jsxs("div", { onClick: (e) => e.stopPropagation(), style: {
                background: '#fff',
                borderRadius: '16px',
                width: '100%',
                maxWidth: '880px',
                height: 'min(85vh, 720px)',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
            }, children: [_jsxs("div", { style: {
                        padding: '18px 24px 14px',
                        borderBottom: '1px solid #eee',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexShrink: 0,
                    }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: 0, fontSize: '18px', fontWeight: 700, color: '#1a1a1a' }, children: "Bulk Photo Edit" }), _jsxs("p", { style: { margin: '2px 0 0', fontSize: '13px', color: '#888' }, children: [selectedIndices.length, " photo", selectedIndices.length !== 1 ? 's' : '', " \u2014 drag slider to preview changes live"] })] }), _jsx("button", { onClick: () => !processing && onCancel(), style: {
                                background: 'none',
                                border: 'none',
                                fontSize: '22px',
                                color: '#999',
                                cursor: processing ? 'not-allowed' : 'pointer',
                                lineHeight: 1,
                                padding: '4px 8px',
                                borderRadius: '6px',
                            }, children: "\u2715" })] }), _jsxs("div", { style: {
                        padding: '14px 24px 16px',
                        borderBottom: '1px solid #f0f0f0',
                        background: '#fafbfc',
                        flexShrink: 0,
                    }, children: [_jsxs("div", { style: { marginBottom: '12px' }, children: [_jsxs("div", { style: {
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        marginBottom: '6px',
                                    }, children: [_jsx("span", { style: { fontSize: '13px', fontWeight: 600, color: '#333' }, children: "Size" }), _jsxs("span", { style: {
                                                fontSize: '15px',
                                                fontWeight: 700,
                                                color: scale === 1 ? '#999' : '#0064d3',
                                                fontVariantNumeric: 'tabular-nums',
                                            }, children: [Math.round(scale * 100), "%"] })] }), _jsx("input", { type: "range", min: "0.4", max: "1.5", step: "0.01", value: scale, onChange: (e) => setScale(parseFloat(e.target.value)), disabled: processing, style: { width: '100%', accentColor: '#0064d3' } }), _jsx("div", { style: { display: 'flex', gap: '5px', marginTop: '6px', flexWrap: 'wrap' }, children: presetScales.map(({ label, value }) => (_jsx("button", { onClick: () => setScale(value), disabled: processing, style: {
                                            background: Math.abs(scale - value) < 0.01 ? '#0064d3' : '#fff',
                                            color: Math.abs(scale - value) < 0.01 ? '#fff' : '#555',
                                            border: `1px solid ${Math.abs(scale - value) < 0.01 ? '#0064d3' : '#ddd'}`,
                                            borderRadius: '6px',
                                            padding: '3px 10px',
                                            fontSize: '12px',
                                            fontWeight: 500,
                                            cursor: 'pointer',
                                        }, children: label }, value))) })] }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }, children: [_jsxs("span", { style: { fontSize: '13px', fontWeight: 600, color: '#333', marginRight: '2px' }, children: ["Rotate", rotation !== 0 ? ` (${rotation}°)` : ''] }), [
                                    { label: '↺90', deg: -90 },
                                    { label: '↺15', deg: -15 },
                                    { label: '↺5', deg: -5 },
                                    { label: '↻5', deg: 5 },
                                    { label: '↻15', deg: 15 },
                                    { label: '↻90', deg: 90 },
                                ].map(({ label, deg }) => (_jsx("button", { onClick: () => setRotation((r) => r + deg), disabled: processing, style: {
                                        background: '#fff',
                                        border: '1px solid #ddd',
                                        borderRadius: '6px',
                                        padding: '3px 8px',
                                        fontSize: '12px',
                                        cursor: 'pointer',
                                        color: '#555',
                                    }, children: label }, deg))), rotation !== 0 && (_jsx("button", { onClick: () => setRotation(0), style: {
                                        background: '#fff',
                                        border: '1px solid #e0c0c0',
                                        borderRadius: '6px',
                                        padding: '3px 8px',
                                        fontSize: '12px',
                                        cursor: 'pointer',
                                        color: '#c00',
                                    }, children: "Reset" }))] })] }), _jsx("div", { style: {
                        flex: '1 1 0',
                        minHeight: 0,
                        overflowY: 'auto',
                        padding: '16px 24px',
                    }, children: _jsx("div", { style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                            gap: '12px',
                        }, children: selectedIndices.map((idx) => (_jsx(PreviewCard, { url: allImageUrls[idx], index: idx, scale: scale, rotation: rotation }, idx))) }) }), _jsxs("div", { style: {
                        padding: '14px 24px',
                        borderTop: '1px solid #eee',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: '#fafbfc',
                        flexShrink: 0,
                        borderRadius: '0 0 16px 16px',
                    }, children: [_jsxs("div", { style: { minHeight: '24px' }, children: [error && _jsx("span", { style: { color: '#c00', fontSize: '13px' }, children: error }), processing && (_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '10px' }, children: [_jsx("div", { style: {
                                                width: '140px',
                                                height: '6px',
                                                background: '#e0e0e0',
                                                borderRadius: '3px',
                                                overflow: 'hidden',
                                            }, children: _jsx("div", { style: {
                                                    width: `${(progress / selectedIndices.length) * 100}%`,
                                                    height: '100%',
                                                    background: '#0064d3',
                                                    borderRadius: '3px',
                                                    transition: 'width 0.3s ease',
                                                } }) }), _jsxs("span", { style: { fontSize: '13px', color: '#666' }, children: [progress, "/", selectedIndices.length] })] }))] }), _jsxs("div", { style: { display: 'flex', gap: '10px' }, children: [_jsx("button", { onClick: () => !processing && onCancel(), disabled: processing, style: {
                                        background: '#fff',
                                        border: '1px solid #ddd',
                                        borderRadius: '8px',
                                        padding: '8px 20px',
                                        fontSize: '14px',
                                        fontWeight: 500,
                                        cursor: processing ? 'not-allowed' : 'pointer',
                                        color: '#555',
                                    }, children: "Cancel" }), _jsx("button", { onClick: handleApply, disabled: processing || noChange, style: {
                                        background: (noChange || processing) ? '#ccc' : '#0064d3',
                                        color: '#fff',
                                        border: 'none',
                                        borderRadius: '8px',
                                        padding: '8px 24px',
                                        fontSize: '14px',
                                        fontWeight: 600,
                                        cursor: (noChange || processing) ? 'not-allowed' : 'pointer',
                                    }, children: processing
                                        ? 'Processing...'
                                        : `Apply to ${selectedIndices.length} Photo${selectedIndices.length !== 1 ? 's' : ''}` })] })] })] }) }));
    return createPortal(modal, document.body);
};
export default BulkPhotoEditor;
