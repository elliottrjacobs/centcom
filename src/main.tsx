import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConnectionGate } from './ConnectionGate';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/editor.css';
import './styles/views.css';

if (window.centcom?.isElectron) document.documentElement.classList.add('is-electron');


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionGate><App /></ConnectionGate>
  </StrictMode>,
);
