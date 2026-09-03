import React from 'react';
import '../styles/help.css';
export interface HelpArticle {
    id: number;
    question: string;
    answer: string;
    category: string;
    sort_order: number;
    updated_at: string;
}
export interface HelpCategoryInfo {
    name: string;
    slug: string;
    count: number;
    icon: string;
    color: string;
    description: string;
}
export declare const categorySlug: (name: string) => string;
export declare const categoryFromSlug: (slug: string, categories: string[]) => string;
declare const HelpCenter: React.FC;
export default HelpCenter;
