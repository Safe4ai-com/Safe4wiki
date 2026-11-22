import vscode from './vscode.js';
import { transformers, playwright, mineru } from './others.js';

// Sample wikis shipped with the app (shown until you generate your own).
export const demoWikis = [vscode, transformers, playwright, mineru];

export function findDemo(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  return demoWikis.find(w => w.id.toLowerCase() === key) || null;
}
