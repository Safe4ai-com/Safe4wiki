import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './assistant.css';

const root = document.getElementById('root');
if (!root) throw new Error('The Safe4wiki page has no application root.');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
