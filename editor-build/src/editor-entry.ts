import {createSourceEditor} from './source-editor';
const textarea=document.getElementById('editor') as HTMLTextAreaElement;
const editor=createSourceEditor(textarea);
(globalThis as any).microduckSourceEditor=editor;
document.dispatchEvent(new Event('microduck-editor-ready'));
