import vscode from './vscode.js';
import playwright from './playwright.js';

// Complete example wikis shipped with Safe4wiki (generated with real models).
export const demoWikis = [vscode, playwright];

export function findDemo(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  return demoWikis.find(w => w.id.toLowerCase() === key) || null;
}
