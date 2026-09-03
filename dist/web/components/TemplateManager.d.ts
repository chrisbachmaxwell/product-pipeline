import React from 'react';
interface TemplateManagerProps {
    /** If provided, the "Apply" button will use this product ID */
    productId?: string;
    /** Called after a template is applied to a product */
    onApplied?: (templateId: number) => void;
    /** Initial category to pre-fill when creating new templates */
    initialCategory?: string;
}
declare const TemplateManager: React.FC<TemplateManagerProps>;
export default TemplateManager;
