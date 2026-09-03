import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useRef, useEffect, useCallback } from 'react';
const DEFAULT_TRANSFORM = { rotation: 0, scale: 1, offsetX: 0, offsetY: 0 };
const CANVAS_SIZE = 4000;
const WATERMARK_FONT_SIZE = 24;
const WATERMARK_PADDING = 20;
const PREVIEW_SIZE = 380;
// ── Styles ─────────────────────────────────────────────────────────────
const overlayStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2147483647, // max 32-bit int — above everything
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
};
const backdropStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
};
const dialogStyle = {
    position: 'relative',
    background: '#fff',
    borderRadius: '12px',
    width: '90vw',
    maxWidth: '680px',
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
    display: 'flex',
    flexDirection: 'column',
};
const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #e3e5e7',
};
const bodyStyle = {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
};
const footerStyle = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '12px 20px',
    borderTop: '1px solid #e3e5e7',
};
const btnStyle = {
    padding: '8px 16px',
    borderRadius: '6px',
    border: '1px solid #ccc',
    background: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
};
const btnPrimaryStyle = {
    ...btnStyle,
    background: '#2c6ecb',
    color: '#fff',
    border: '1px solid #2c6ecb',
};
const sliderRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
};
// ── Component ──────────────────────────────────────────────────────────
const ProductPhotoEditor = ({ imageUrl, draftId, imageIndex, allDraftImages, onSave, onClose, open, onCustomSave, productId, }) => {
    const canvasRef = useRef(null);
    const [productImg, setProductImg] = useState(null);
    const [transform, setTransform] = useState({ ...DEFAULT_TRANSFORM });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [dragging, setDragging] = useState(false);
    const dragStart = useRef(null);
    // ── Load product image ─────────────────────────────────────────────
    useEffect(() => {
        if (!open || !imageUrl)
            return;
        setLoading(true);
        setError(null);
        const proxyGcs = (path) => `/api/images/proxy?url=${encodeURIComponent(path)}`;
        const loadImage = (url, fallbacks) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => { setProductImg(img); setLoading(false); };
            img.onerror = () => {
                if (fallbacks.length > 0) {
                    loadImage(fallbacks[0], fallbacks.slice(1));
                }
                else {
                    setError('Failed to load image.');
                    setLoading(false);
                }
            };
            img.src = url;
        };
        // Build GCS base from productId prop OR regex from URL
        const match = imageUrl.match(/(\d{10,})_(\d+)\.png/);
        const pid = productId || (match ? match[1] : null);
        const idx = match ? match[2] : String(imageIndex);
        const gcsBase = pid
            ? `https://storage.googleapis.com/pictureline-product-photos/processed/${pid}_${idx}`
            : null;
        // Priority: cutout (transparent bg) → clean (white bg) → original URL
        const urls = [];
        if (gcsBase) {
            urls.push(proxyGcs(`${gcsBase}_cutout.png`));
            urls.push(proxyGcs(`${gcsBase}_clean.png`));
            urls.push(proxyGcs(`${gcsBase}.png`));
        }
        urls.push(imageUrl);
        loadImage(urls[0], urls.slice(1));
    }, [imageUrl, open]);
    useEffect(() => { setTransform({ ...DEFAULT_TRANSFORM }); }, [imageUrl]);
    // ── Render canvas ──────────────────────────────────────────────────
    // Preview render: white bg + product + simple shadow for visual feedback
    const renderPreview = useCallback((ctx, size, img, t) => {
        const { rotation, scale, offsetX, offsetY } = t;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, size, size);
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
        // Simple preview shadow (PhotoRoom will add the real one)
        ctx.save();
        const shadowCX = size / 2 + offsetX;
        const shadowY = size / 2 + (drawH * scale) / 2 + size * 0.015;
        const grad = ctx.createRadialGradient(shadowCX, shadowY, 0, shadowCX, shadowY, drawW * scale * 0.5);
        grad.addColorStop(0, 'rgba(0,0,0,0.08)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(shadowCX, shadowY, drawW * scale * 0.5, size * 0.015, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Product
        ctx.save();
        ctx.translate(size / 2 + offsetX, size / 2 + offsetY);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(scale, scale);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
    }, []);
    // Export render: rotated product on TRANSPARENT background (for PhotoRoom reprocessing)
    const renderForExport = useCallback((img, t) => {
        const size = CANVAS_SIZE;
        const offscreen = document.createElement('canvas');
        offscreen.width = size;
        offscreen.height = size;
        const ctx = offscreen.getContext('2d');
        // Transparent background — PhotoRoom will add white bg + shadow
        ctx.clearRect(0, 0, size, size);
        const previewSize = canvasRef.current?.width || PREVIEW_SIZE;
        const scaleFactor = size / previewSize;
        const { rotation, scale, offsetX, offsetY } = t;
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
        ctx.translate(size / 2 + offsetX * scaleFactor, size / 2 + offsetY * scaleFactor);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(scale, scale);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
        return offscreen;
    }, []);
    // Re-render on transform/image change
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !productImg)
            return;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            return;
        renderPreview(ctx, canvas.width, productImg, transform);
    }, [productImg, transform, renderPreview]);
    // ── Drag handlers ──────────────────────────────────────────────────
    const handlePointerDown = useCallback((e) => {
        setDragging(true);
        dragStart.current = { x: e.clientX, y: e.clientY, offsetX: transform.offsetX, offsetY: transform.offsetY };
        e.target.setPointerCapture(e.pointerId);
    }, [transform.offsetX, transform.offsetY]);
    const handlePointerMove = useCallback((e) => {
        if (!dragging || !dragStart.current || !canvasRef.current)
            return;
        const canvas = canvasRef.current;
        const scaleFactor = canvas.width / canvas.clientWidth;
        const dx = (e.clientX - dragStart.current.x) * scaleFactor;
        const dy = (e.clientY - dragStart.current.y) * scaleFactor;
        setTransform(prev => ({ ...prev, offsetX: dragStart.current.offsetX + dx, offsetY: dragStart.current.offsetY + dy }));
    }, [dragging]);
    const handlePointerUp = useCallback(() => { setDragging(false); dragStart.current = null; }, []);
    // ── Save handler ───────────────────────────────────────────────────
    const handleSave = useCallback(async () => {
        if (!productImg)
            return;
        setSaving(true);
        setError(null);
        try {
            // 1. Export rotated product on transparent background
            const exportCanvas = renderForExport(productImg, transform);
            const blob = await new Promise((resolve, reject) => {
                exportCanvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))), 'image/png');
            });
            if (onCustomSave) {
                // Custom save path: send transparent PNG to PhotoRoom via backend, then save result
                const formData = new FormData();
                formData.append('image', blob, `rotated-${Date.now()}.png`);
                const prRes = await fetch('/api/images/reprocess-edited', { method: 'POST', body: formData });
                if (!prRes.ok) {
                    const d = await prRes.json().catch(() => ({ error: 'Reprocess failed' }));
                    throw new Error(d.error || `PhotoRoom reprocess failed (${prRes.status})`);
                }
                const prData = await prRes.json();
                // Convert the processed data URL to a blob for onCustomSave
                const processedRes = await fetch(prData.dataUrl);
                const processedBlob = await processedRes.blob();
                await onCustomSave(processedBlob);
                onClose();
                return;
            }
            // Draft save path: send to PhotoRoom then update draft
            const formData = new FormData();
            formData.append('image', blob, `rotated-${draftId}-${imageIndex}-${Date.now()}.png`);
            const prRes = await fetch('/api/images/reprocess-edited', { method: 'POST', body: formData });
            if (!prRes.ok) {
                const d = await prRes.json().catch(() => ({ error: 'Reprocess failed' }));
                throw new Error(d.error || `PhotoRoom reprocess failed (${prRes.status})`);
            }
            const prData = await prRes.json();
            const updatedImages = [...allDraftImages];
            updatedImages[imageIndex] = prData.dataUrl;
            const updateRes = await fetch(`/api/drafts/${draftId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ images: updatedImages }),
            });
            if (!updateRes.ok)
                throw new Error('Failed to update draft');
            onSave(updatedImages);
            onClose();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Save failed');
        }
        finally {
            setSaving(false);
        }
    }, [productImg, transform, draftId, imageIndex, allDraftImages, onSave, onClose, renderForExport, onCustomSave]);
    // ── Escape key ─────────────────────────────────────────────────────
    useEffect(() => {
        if (!open)
            return;
        const handler = (e) => { if (e.key === 'Escape')
            onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);
    // ── Render ─────────────────────────────────────────────────────────
    if (!open)
        return null;
    return (_jsxs("div", { style: overlayStyle, children: [_jsx("div", { style: backdropStyle, onClick: onClose }), _jsxs("div", { style: dialogStyle, children: [_jsxs("div", { style: headerStyle, children: [_jsx("h2", { style: { margin: 0, fontSize: '16px', fontWeight: 600 }, children: "Edit Product Photo" }), _jsx("button", { onClick: onClose, style: { ...btnStyle, border: 'none', fontSize: '18px', padding: '4px 8px' }, children: "\u2715" })] }), _jsxs("div", { style: bodyStyle, children: [error && (_jsx("div", { style: { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '8px 12px', color: '#991b1b', fontSize: '13px' }, children: error })), loading ? (_jsx("div", { style: { textAlign: 'center', padding: '3rem' }, children: _jsx("div", { style: { fontSize: '14px', color: '#6b7280' }, children: "Loading image..." }) })) : (_jsxs(_Fragment, { children: [_jsx("div", { style: { display: 'flex', justifyContent: 'center', background: '#f3f4f6', borderRadius: '8px', padding: '8px' }, children: _jsx("canvas", { ref: canvasRef, width: PREVIEW_SIZE, height: PREVIEW_SIZE, style: {
                                                width: `${PREVIEW_SIZE}px`,
                                                height: `${PREVIEW_SIZE}px`,
                                                maxWidth: '100%',
                                                cursor: dragging ? 'grabbing' : 'grab',
                                                borderRadius: '4px',
                                                border: '1px solid #e3e5e7',
                                            }, onPointerDown: handlePointerDown, onPointerMove: handlePointerMove, onPointerUp: handlePointerUp, onPointerLeave: handlePointerUp }) }), _jsx("div", { style: { textAlign: 'center', fontSize: '12px', color: '#6b7280' }, children: "\u2195 Drag to reposition \u00B7 Use sliders to rotate and scale" }), _jsxs("div", { style: sliderRowStyle, children: [_jsxs("span", { style: { fontSize: '13px', width: '95px', flexShrink: 0 }, children: ["Rotation: ", transform.rotation, "\u00B0"] }), _jsx("input", { type: "range", min: -180, max: 180, step: 1, value: transform.rotation, onChange: e => setTransform(prev => ({ ...prev, rotation: Number(e.target.value) })), style: { flex: 1 } })] }), _jsxs("div", { style: sliderRowStyle, children: [_jsxs("span", { style: { fontSize: '13px', width: '95px', flexShrink: 0 }, children: ["Scale: ", Math.round(transform.scale * 100), "%"] }), _jsx("input", { type: "range", min: 50, max: 200, step: 1, value: Math.round(transform.scale * 100), onChange: e => setTransform(prev => ({ ...prev, scale: Number(e.target.value) / 100 })), style: { flex: 1 } })] })] }))] }), _jsxs("div", { style: footerStyle, children: [_jsx("button", { style: btnStyle, onClick: () => setTransform({ ...DEFAULT_TRANSFORM }), children: "Reset" }), _jsx("button", { style: btnStyle, onClick: onClose, children: "Cancel" }), _jsx("button", { style: { ...btnPrimaryStyle, opacity: (loading || !productImg || saving) ? 0.5 : 1 }, onClick: handleSave, disabled: loading || !productImg || saving, children: saving ? 'Processing with PhotoRoom...' : 'Save & Replace' })] })] })] }));
};
export default ProductPhotoEditor;
