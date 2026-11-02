import { Select } from '../ui/Select';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Doc, FileKind, TreeNode } from '@shared/types';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { externalLinkProps, openFileProps } from '../lib/actions';
import { api } from '../lib/api';
import { formatBytes, fullDate, pluralize, relTime, safeName, stripExt } from '../lib/format';
import { libraryFiles, libraryPath, type LibrarySort } from '../lib/library';
import { href, navigate } from '../lib/router';
import { findNode, refreshTree, useStore } from '../lib/store';
import { ViewHeader } from '../shell/ViewHeader';
import { BookOpen, Document, File, FilePdf, Image, Link, Music, Plus, Upload, Video } from '../ui/icons';
import { prompt, toast, toastError } from '../ui/overlays';

const KIND_ICON: Record<FileKind, ReactNode> = {
  markdown: <Document size={16} />,
  link: <Link size={16} />,
  image: <Image size={16} />,
  pdf: <FilePdf size={16} />,
  video: <Video size={16} />,
  audio: <Music size={16} />,
  other: <File size={16} />,
};

/** Markdown opens as a doc, a saved link at its site, any other file raw. */
function LibraryRow({ file, root }: { file: TreeNode; root: string }) {
  const kind = file.kind ?? 'other';
  const folder = file.path.slice(root.length + 1).split('/').slice(0, -1).join('/');
  const isDoc = kind === 'markdown';
  const meta = [folder, kind === 'link' ? file.site : !isDoc && file.size !== undefined ? formatBytes(file.size) : ''].filter(Boolean).join(' · ');
  const target = isDoc ? { href: href({ name: 'doc', path: file.path }) } : kind === 'link' && file.url ? externalLinkProps(file.url) : openFileProps(file.path, file.mtime);
  return <a className="file-row" {...target} draggable={false}><span className="file-icon">{KIND_ICON[kind]}</span><span className="file-name truncate">{isDoc || kind === 'link' ? (file.title ?? stripExt(file.name)) : file.name}</span>{meta && <span className="file-meta truncate">{meta}</span>}<time className="file-date" title={fullDate(file.mtime)}>{relTime(file.mtime)}</time></a>;
}

/** The project's library: its docs, documentation, outputs and files of any kind. */
export function LibraryView({ slug }: { slug: string }) {
  const tree = useStore((s) => s.tree);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('title');
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const root = libraryPath(slug);
  const files = libraryFiles(findNode(tree, root), { query, sort });
  const create = async () => {
    const title = await prompt({ title: 'New doc', label: 'Title', placeholder: 'Launch plan', confirmLabel: 'Create' });
    const name = title && safeName(title);
    if (!name) return;
    try {
      const doc = await api.createDoc(`${root}/${name}.md`, '', { title });
      await refreshTree();
      navigate({ name: 'doc', path: doc.path });
    } catch (error) { toastError(error); }
  };
  const upload = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      for (const file of chosen) await api.upload(root, file, file.name);
      await refreshTree();
      toast(`${pluralize(chosen.length, 'file')} added to the Library`);
    } catch (error) { toastError(error); } finally {
      setUploading(false);
      if (picker.current) picker.current.value = '';
    }
  };
  return <div className="view-body"><div className="page">
    <div className="section-head"><div><h2 className="section-title">Library</h2><p className="quiet">Docs, documentation, outputs and files for this project.</p></div><div className="chip-row"><button className="btn btn-sm" disabled={uploading} onClick={() => picker.current?.click()}><Upload size={14} /> {uploading ? 'Uploading…' : 'Upload'}</button><button className="btn btn-sm" onClick={() => void create()}><Plus size={14} /> New doc</button></div></div>
    <input ref={picker} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
    <div className="task-controls"><input type="search" aria-label="Search the library" placeholder="Find docs and files…" value={query} onChange={e => setQuery(e.target.value)} /><Select aria-label="Sort the library" value={sort} onChange={value => setSort(value as LibrarySort)}><option value="title">Title A–Z</option><option value="updated">Recently updated</option></Select></div>
    {query && files.length === 0 ? <p className="quiet">No matching docs or files.</p> : files.length === 0 ? <div className="empty"><BookOpen size={28} className="empty-icon" /><div className="empty-title">Your project library</div><p className="empty-body">Add docs, decisions, runbooks, outputs and files for this project. Create a doc, or upload images, PDFs and anything else.</p></div> : <div className="file-list">{files.map((file) => <LibraryRow key={file.path} file={file} root={root} />)}</div>}
  </div></div>;
}

export function LibraryPage({ path }: { path: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const slug = path.split('/')[1]!;
  const fileMtime = useStore((s) => findNode(s.tree, path)?.mtime);
  const dirty = doc !== null && body !== doc.body;
  useEffect(() => {
    if (dirty) return;
    let live = true;
    api.doc(path).then((d) => { if (live) { setDoc(d); setBody(d.body); } }).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [path, fileMtime]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const beforeLink = (e: MouseEvent) => {
      const link = (e.target as Element)?.closest('a[href]');
      if (link && !window.confirm('Leave this doc without saving your changes?')) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', beforeLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', beforeLink, true); };
  }, [dirty]);
  const save = async () => {
    if (!doc) return;
    setBusy(true); setError('');
    try { const next = await api.saveDoc({ path, body, ifMatch: doc.mtime }); setDoc(next); setBody(next.body); await refreshTree(); toast('Doc saved'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <><ViewHeader crumbs={[{ label: slug, to: { name: 'project', slug, tab: 'overview' } }, { label: 'Library', to: { name: 'project', slug, tab: 'library' } }, { label: doc?.title ?? 'Doc' }]}><span className="quiet">{dirty ? 'Unsaved changes' : 'Saved'}</span><button className="btn btn-sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></ViewHeader><div className="view-body"><article className="doc">{error && <p role="alert">{error}</p>}{doc && <><h1 className="doc-title">{doc.title}</h1><MarkdownEditor value={body} revision={doc.mtime} docPath={path} onChange={setBody} /></>}</article></div></>;
}
