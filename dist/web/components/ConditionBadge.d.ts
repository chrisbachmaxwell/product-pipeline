import React from 'react';
type BadgeTone = 'success' | 'info' | 'attention' | 'warning' | 'critical';
/**
 * Extract condition tag from a tags array and render a Polaris Badge.
 * Returns null if no condition tag found.
 */
export declare function getConditionFromTags(tags: string[]): {
    label: string;
    tone: BadgeTone;
} | null;
declare const ConditionBadge: React.FC<{
    tags?: string[];
}>;
export default ConditionBadge;
