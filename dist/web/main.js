import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import './styles.css';
import App from './App';
const root = document.getElementById('root');
if (!root) {
    throw new Error('Root element not found');
}
createRoot(root).render(_jsx(React.StrictMode, { children: _jsx(App, {}) }));
