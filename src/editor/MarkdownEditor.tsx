import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, mergeAttributes, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react';
import { buildBaseline, patchMarkdown, type Baseline, type MarkdownManagerLike } from './fidelity';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { api, rawUrl } from '../lib/api';
import { isImageName } from '../lib/actions';
import { dirname, joinPath, safeName } from '../lib/format';
import { refreshTree } from '../lib/store';
import { StrikeGlyph } from '../ui/glyphs';
import {
  Bold,
  ChevronDown,
  Code,
  CodeSquare,
  Grid,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListCheck,
  Hashtag,
  Minus,
  QuoteUp,
  Redo,
  Text as TextIcon,
  Undo,
} from '../ui/icons';
import { Menu, Popover, prompt, toastError, usePopover } from '../ui/overlays';

interface Props {
  /** Markdown body (no frontmatter). Treated as the initial value; see `revision`. */
  value: string;
  onChange: (markdown: string) => void;
  /** Bump to force-load `value` into the editor (external change, switching documents). */
  revision?: string | number;
  /** Vault path of the file being edited, used to resolve relative images and place uploads. */
  docPath: string;
  placeholder?: string;
  toolbar?: boolean;
  autoFocus?: boolean;
  /** Compact variant for ticket descriptions and comments. */
  compact?: boolean;
  /**
   * Render-only. Used for agent-written comments: content is parsed through the
   * editor schema, so markup outside it (scripts, handlers) cannot survive.
   */
  readOnly?: boolean;
  onSubmit?: () => void;
}

/** Resolve a markdown image `src` against the document's folder into a vault path. */
function resolveVaultPath(docPath: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null; // absolute URL: leave alone
  const clean = decodeURI(src.split(/[?#]/)[0] ?? '');
  const base = clean.startsWith('/') ? [] : dirname(docPath).split('/').filter(Boolean);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}

export function MarkdownEditor({
  value,
  onChange,
  revision,
  docPath,
  placeholder = 'Start writing…',
  toolbar = true,
  autoFocus,
  compact,
  readOnly,
  onSubmit,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const docPathRef = useRef(docPath);
  docPathRef.current = docPath;
  // What the editor last emitted, so we can tell our own echo from a real external change.
  const lastEmitted = useRef(value);
  // The text the current content was loaded from. Saves are patched against it (see fidelity.ts);
  // `built` is computed on the first edit, since most documents are only ever read.
  const baseline = useRef<{ src: string; built?: Baseline | null }>({ src: value });
  const nodeCache = useRef(new WeakMap<object, string>());

  /** The document as markdown, with every block the user has not touched emitted verbatim. */
  const toMarkdown = (ed: Editor): string => {
    const manager = ed.storage.markdown?.manager as MarkdownManagerLike | undefined;
    if (!manager) return ed.getMarkdown();
    if (baseline.current.built === undefined) baseline.current.built = buildBaseline(manager, baseline.current.src);
    const parts: string[] = [];
    // ProseMirror nodes are immutable, so an unedited block is the same object on every
    // keystroke and only the block being typed in is re-serialized.
    ed.state.doc.forEach((node) => {
      let md = nodeCache.current.get(node);
      if (md === undefined) {
        md = manager.serialize({ type: 'doc', content: [node.toJSON() as JSONContent] });
        nodeCache.current.set(node, md);
      }
      parts.push(md);
    });
    return patchMarkdown(parts, baseline.current.built);
  };

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Markdown has no underline; keeping it out means the file never gains HTML.
        underline: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } },
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.extend({
        // Keep the markdown-relative `src` in the document; only the rendered <img> gets the API URL.
        renderHTML({ HTMLAttributes }) {
          const raw = String(HTMLAttributes.src ?? '');
          const vaultPath = resolveVaultPath(docPathRef.current, raw);
          return ['img', mergeAttributes(HTMLAttributes, { src: vaultPath === null ? raw : rawUrl(vaultPath), loading: 'lazy' })];
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placeholder],
  );

  const editor = useEditor({
    extensions,
    content: value,
    contentType: 'markdown',
    editable: !readOnly,
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: `prose selectable${compact ? ' prose-compact' : ''}${readOnly ? ' prose-static' : ''}`,
        spellcheck: readOnly ? 'false' : 'true',
      },
      handleKeyDown: (_view, e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmitRef.current) {
          onSubmitRef.current();
          return true;
        }
        return false;
      },
      handlePaste: (_view, e) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        void insertImages(files);
        return true;
      },
      handleDrop: (_view, e) => {
        const files = Array.from((e as DragEvent).dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        e.preventDefault();
        void insertImages(files);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const md = toMarkdown(editor);
      lastEmitted.current = md;
      onChangeRef.current(md);
    },
  });

  async function insertImages(files: File[]) {
    if (!editor) return;
    const dir = joinPath(dirname(docPathRef.current), 'assets');
    for (const file of files) {
      try {
        const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
        const name = isImageName(file.name) ? safeName(file.name) : `pasted-${Date.now()}.${ext}`;
        const node = await api.upload(dir, file, name);
        // Relative link keeps the markdown portable to Obsidian, GitHub, and agents reading raw files.
        const rel = `assets/${node.name.split('/').map(encodeURIComponent).join('/')}`;
        editor.chain().focus().setImage({ src: rel, alt: node.name.replace(/\.[^.]+$/, '') }).run();
      } catch (err) {
        toastError(err);
      }
    }
    void refreshTree();
  }

  // `editable` is only read at creation; follow the prop so a locked document can be unlocked in place.
  useEffect(() => {
    // `false` = do not emit an update. Unlocking is not an edit: without this, clicking Edit on
    // a linked skill immediately rewrote the file (identical bytes, but a new mtime and a
    // bogus "edited" entry in the activity log).
    if (editor && editor.isEditable === !!readOnly) editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  // Load external content only when told to, never on our own echo.
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmitted.current && revision === undefined) return;
    if (value !== lastEmitted.current || value !== baseline.current.src) {
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
      lastEmitted.current = value;
      baseline.current = { src: value };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, editor]);

  if (!editor) return null;

  return (
    <div className="md-editor" data-compact={compact || undefined}>
      {toolbar && !readOnly && (
        <Toolbar
          editor={editor}
          onPickImage={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.onchange = () => void insertImages(Array.from(input.files ?? []));
            input.click();
          }}
        />
      )}
      <EditorContent editor={editor} className="md-content" />
    </div>
  );
}

/* ───────── Toolbar ───────── */

function Toolbar({
  editor,
  onPickImage,
}: {
  editor: Editor;
  onPickImage: () => void;
}) {
  // Subscribe to just the flags the toolbar shows, so typing doesn't re-render it per keystroke.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      table: e.isActive('table'),
      block: e.isActive('heading', { level: 1 })
        ? 'Heading 1'
        : e.isActive('heading', { level: 2 })
          ? 'Heading 2'
          : e.isActive('heading', { level: 3 })
            ? 'Heading 3'
            : e.isActive('heading', { level: 4 })
              ? 'Heading 4'
              : 'Text',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const blockPop = usePopover();
  const tablePop = usePopover();
  const c = () => editor.chain().focus();

  const setLink = async () => {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
    const url = await prompt({ title: prev ? 'Edit link' : 'Add link', label: 'URL', initial: prev, placeholder: 'https://', confirmLabel: 'Apply' });
    if (url === null) return;
    c().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="md-toolbar" role="toolbar" aria-label="Formatting">
      <button className="tb-block" onClick={(e) => blockPop.open(e.currentTarget)} title="Text style">
        <span>{s.block}</span>
        <ChevronDown size={12} />
      </button>
      {blockPop.anchor && (
        <Popover anchor={blockPop.anchor} onClose={blockPop.close} className="popover-menu">
          <Menu
            onClose={blockPop.close}
            items={[
              { id: 'p', label: 'Text', icon: <TextIcon size={14} />, checked: s.block === 'Text', hint: '⌥⌘0', onSelect: () => c().setParagraph().run() },
              ...([1, 2, 3, 4] as const).map((level) => ({
                id: `h${level}`,
                label: `Heading ${level}`,
                icon: <Hashtag size={14} />,
                checked: s.block === `Heading ${level}`,
                hint: `⌥⌘${level}`,
                onSelect: () => c().setHeading({ level }).run(),
              })),
            ]}
          />
        </Popover>
      )}
      <span className="tb-sep" />
      <Tb on={s.bold} title="Bold  ⌘B" onClick={() => c().toggleBold().run()}><Bold size={16} /></Tb>
      <Tb on={s.italic} title="Italic  ⌘I" onClick={() => c().toggleItalic().run()}><Italic size={16} /></Tb>
      <Tb on={s.strike} title="Strikethrough  ⇧⌘S" onClick={() => c().toggleStrike().run()}><StrikeGlyph /></Tb>
      <Tb on={s.code} title="Inline code  ⌘E" onClick={() => c().toggleCode().run()}><Code size={16} /></Tb>
      <Tb on={s.link} title="Link" onClick={() => void setLink()}><LinkIcon size={16} /></Tb>
      <span className="tb-sep" />
      <Tb on={s.bullet} title="Bulleted list  ⇧⌘8" onClick={() => c().toggleBulletList().run()}><List size={16} /></Tb>
      <Tb on={s.ordered} title="Numbered list  ⇧⌘7" onClick={() => c().toggleOrderedList().run()}><span className="tb-glyph">1.</span></Tb>
      <Tb on={s.task} title="Checklist  ⇧⌘9" onClick={() => c().toggleTaskList().run()}><ListCheck size={16} /></Tb>
      <span className="tb-sep" />
      <Tb on={s.quote} title="Quote  ⇧⌘B" onClick={() => c().toggleBlockquote().run()}><QuoteUp size={16} /></Tb>
      <Tb on={s.codeBlock} title="Code block  ⌥⌘C" onClick={() => c().toggleCodeBlock().run()}><CodeSquare size={16} /></Tb>
      <Tb title="Divider" onClick={() => c().setHorizontalRule().run()}><Minus size={16} /></Tb>
      <Tb on={s.table} title="Table" onClick={(e) => (s.table ? tablePop.open(e.currentTarget) : c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}><Grid size={16} /></Tb>
      {tablePop.anchor && (
        <Popover anchor={tablePop.anchor} onClose={tablePop.close} className="popover-menu">
          <Menu
            onClose={tablePop.close}
            items={[
              { id: 'rb', label: 'Insert row below', onSelect: () => c().addRowAfter().run() },
              { id: 'ra', label: 'Insert row above', onSelect: () => c().addRowBefore().run() },
              { id: 'cr', label: 'Insert column right', onSelect: () => c().addColumnAfter().run() },
              { id: 'cl', label: 'Insert column left', onSelect: () => c().addColumnBefore().run() },
              { id: 'dr', label: 'Delete row', separatorBefore: true, onSelect: () => c().deleteRow().run() },
              { id: 'dc', label: 'Delete column', onSelect: () => c().deleteColumn().run() },
              { id: 'dt', label: 'Delete table', danger: true, onSelect: () => c().deleteTable().run() },
            ]}
          />
        </Popover>
      )}
      <Tb title="Image" onClick={onPickImage}><ImagePlus size={16} /></Tb>
      <span className="tb-sep" />
      <Tb disabled={!s.canUndo} title="Undo  ⌘Z" onClick={() => c().undo().run()}><Undo size={16} /></Tb>
      <Tb disabled={!s.canRedo} title="Redo  ⇧⌘Z" onClick={() => c().redo().run()}><Redo size={16} /></Tb>
      <span className="tb-spacer" />

    </div>
  );
}

function Tb({
  children,
  on,
  ...rest
}: { children: React.ReactNode; on?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="icon-btn tb-btn"
      data-on={on ? 'true' : undefined}
      // Keep the selection in the document when clicking a toolbar button.
      onMouseDown={(e) => e.preventDefault()}
      {...rest}
    >
      {children}
    </button>
  );
}
