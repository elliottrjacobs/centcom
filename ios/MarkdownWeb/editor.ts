import { Editor, mergeAttributes } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { buildBaseline, patchMarkdown } from '../../src/editor/fidelity';

const host = window as any;
let editor: Editor;
let baseline: ReturnType<typeof buildBaseline>;
let source = '';
let docPath = '';
let readOnly = true;
const content = document.querySelector('#editor') as HTMLElement;
const toolbar = document.querySelector('#toolbar') as HTMLElement;
function post(value: object) { host.webkit?.messageHandlers.markdown.postMessage(value); }
function measure() { post({ height: document.documentElement.scrollHeight }); }
function serialize() {
  const manager = editor.storage.markdown.manager;
  const parts: string[] = [];
  editor.state.doc.forEach(node => parts.push(manager.serialize({type:'doc',content:[node.toJSON()]})));
  return patchMarkdown(parts, baseline);
}
function changed() { source = serialize(); post({ markdown: source }); }
function imageURL(src: string) {
  if (/^https?:/i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return '';
  let clean: string;
  try { clean = decodeURI(src.split(/[?#]/)[0] ?? ''); } catch { return ''; }
  const parts = clean.startsWith('/') ? [] : docPath.split('/').slice(0,-1);
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
  }
  return 'centcom-vault://asset/?path=' + encodeURIComponent(parts.join('/'));
}
const actions: [string,string,(e: Editor)=>void][] = [
 ['Heading','H',e=>e.chain().focus().toggleHeading({level:2}).run()],
 ['Bold','B',e=>e.chain().focus().toggleBold().run()],
 ['Italic','I',e=>e.chain().focus().toggleItalic().run()],
 ['Strikethrough','S̶',e=>e.chain().focus().toggleStrike().run()],
 ['Bulleted list','•',e=>e.chain().focus().toggleBulletList().run()],
 ['Numbered list','1.',e=>e.chain().focus().toggleOrderedList().run()],
 ['Checklist','☑',e=>e.chain().focus().toggleTaskList().run()],
 ['Quote','❝',e=>e.chain().focus().toggleBlockquote().run()],
 ['Inline code','<>',e=>e.chain().focus().toggleCode().run()],
 ['Code block','{ }',e=>e.chain().focus().toggleCodeBlock().run()],
 ['Divider','—',e=>e.chain().focus().setHorizontalRule().run()],
 ['Table','▦',e=>e.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run()],
 ['Add table row','+ row',e=>e.chain().focus().addRowAfter().run()],
 ['Add table column','+ col',e=>e.chain().focus().addColumnAfter().run()],
 ['Delete table','− table',e=>e.chain().focus().deleteTable().run()],
 ['Link','↗',e=>{const url=prompt('Link URL (https://…)');if(url && /^https?:\/\//i.test(url)) e.chain().focus().extendMarkRange('link').setLink({href:url}).run();}],
 ['Image','Image',e=>{const url=prompt('Image URL (https://…)');if(url && /^https?:\/\//i.test(url))e.chain().focus().setImage({src:url}).run();}],
 ['Undo','↶',e=>e.chain().focus().undo().run()],
 ['Redo','↷',e=>e.chain().focus().redo().run()],
];
for (const [label,title,action] of actions) {
 const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.textContent=title;
 button.onpointerdown=e=>e.preventDefault();button.onclick=()=>{action(editor);};toolbar.append(button);
}
host.setMarkdown=(config:{markdown:string;readOnly:boolean;docPath:string})=>{
 docPath=config.docPath;
 if(!editor){
  source=config.markdown;readOnly=config.readOnly;
  editor=new Editor({element:content,extensions:[StarterKit.configure({underline:false,link:{openOnClick:readOnly,HTMLAttributes:{rel:'noopener noreferrer'}}}),Placeholder.configure({placeholder:"Write a description…"}),Markdown,TaskList,TaskItem.configure({nested:true}),TableKit,Image.extend({renderHTML({HTMLAttributes}){return ['img',mergeAttributes(HTMLAttributes,{src:imageURL(String(HTMLAttributes.src??''))})];}})],content:source,contentType:'markdown',editable:!readOnly,onUpdate:changed});
  baseline=buildBaseline(editor.storage.markdown.manager,source);
 }else if(source!==config.markdown){source=config.markdown;editor.commands.setContent(source,{contentType:'markdown',emitUpdate:false});baseline=buildBaseline(editor.storage.markdown.manager,source);}
 readOnly=config.readOnly;toolbar.hidden=true;editor.setEditable(!readOnly);document.body.classList.toggle('reading',readOnly);requestAnimationFrame(measure);
};
host.markdownCommand = (name: string) => {
 if(readOnly) return;
 actions.find(a => a[0] === name)?.[2](editor);
};
document.addEventListener('focusin', e => { if(content.contains(e.target as Node)) post({focused:true}); });
document.addEventListener('focusout', () => { setTimeout(() => { if(!content.contains(document.activeElement)) post({focused:false}); },100); });
new ResizeObserver(measure).observe(document.body);
post({ready:true});
