import React from 'react';
interface PipelineProgressProps {
    jobId: string;
    /** Called when job completes or fails */
    onComplete?: (status: 'completed' | 'failed', title?: string) => void;
    /** Compact mode for inline use */
    compact?: boolean;
}
declare const PipelineProgress: React.FC<PipelineProgressProps>;
export default PipelineProgress;
