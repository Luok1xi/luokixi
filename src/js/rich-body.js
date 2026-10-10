import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import '../styles/rich-body.css';

// Keep the original text byte-for-byte until the user edits it. No second HTML
// document is stored: the textarea remains the canonical body used by AI tools.
export function plainBodyDocument(text = '') {
  return { type: 'doc', content: String(text).replace(/\r\n?/g, '\n').split(/\n\n/).map(part => ({
    type: 'paragraph', content: part.split('\n').flatMap((line, index) => [
      ...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : []),
    ]),
  })) };
}

let serial = 0;
export function mountRichBody(textarea, { format = 'plain' } = {}) {
  const container = document.createElement('div');
  container.className = 'rich-body';
  const toolbar = document.createElement('div');
  toolbar.className = 'rb-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '正文格式');
  const surface = document.createElement('div'); surface.className = 'rb-surface';
  const source = document.createElement('button'); source.type = 'button'; source.textContent = '原文'; source.setAttribute('aria-pressed', 'false');
  const id = 'rich-body-' + ++serial;
  surface.id = id; source.setAttribute('aria-controls', id);
  container.append(toolbar, surface); textarea.before(container);
  const initialHidden = textarea.hidden;
  let bodyFormat = format === 'markdown' ? 'markdown' : 'plain', sourceMode = false, syncing = false, resetTimer;
  const controller = new AbortController();
  let editor;
  editor = new Editor({
    element: surface,
    extensions: [StarterKit.configure({
      heading: { levels: [1, 2, 3] }, strike: false, underline: false,
      link: { openOnClick: false, autolink: false, isAllowedUri: uri => /^https?:\/\//i.test(uri) },
    }), Markdown],
    content: bodyFormat === 'markdown' ? textarea.value : plainBodyDocument(textarea.value),
    ...(bodyFormat === 'markdown' ? { contentType: 'markdown' } : {}),
    editorProps: { attributes: { 'aria-label': textarea.getAttribute('aria-label') || '正文', 'aria-multiline': 'true', role: 'textbox', spellcheck: 'true' } },
    onUpdate({ editor: current }) {
      if (syncing) return;
      textarea.value = current.getMarkdown(); bodyFormat = 'markdown';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    },
    onSelectionUpdate() { updateButtons(); },
  });
  const actions = [
    ['加粗', 'bold', e => e.chain().focus().toggleBold().run()],
    ['斜体', 'italic', e => e.chain().focus().toggleItalic().run()],
    ['标题', 'heading', e => e.chain().focus().toggleHeading({ level: 2 }).run()],
    ['列表', 'bulletList', e => e.chain().focus().toggleBulletList().run()],
    ['引用', 'blockquote', e => e.chain().focus().toggleBlockquote().run()],
    ['代码', 'code', e => e.chain().focus().toggleCode().run()],
    ['撤销', null, e => e.chain().focus().undo().run()],
    ['重做', null, e => e.chain().focus().redo().run()],
  ];
  for (const [label, mark, action] of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    if (mark) button.dataset.mark = mark;
    button.addEventListener('click', () => { action(editor); updateButtons(); }, { signal: controller.signal });
    toolbar.append(button);
  }
  toolbar.append(source);
  function updateButtons() {
    if (!editor) return;
    for (const button of toolbar.querySelectorAll('[data-mark]')) button.setAttribute('aria-pressed', String(editor.isActive(button.dataset.mark)));
  }
  function showSource(value) {
    sourceMode = value; textarea.hidden = !value; surface.hidden = value;
    for (const button of toolbar.querySelectorAll('button')) if (button !== source) button.disabled = value;
    source.setAttribute('aria-pressed', String(value)); source.textContent = value ? '排版' : '原文';
    if (value) textarea.focus(); else editor.commands.focus();
  }
  function loadCurrent() {
    syncing = true;
    try { editor.commands.setContent(bodyFormat === 'markdown' ? textarea.value : plainBodyDocument(textarea.value),
      { emitUpdate: false, ...(bodyFormat === 'markdown' ? { contentType: 'markdown' } : {}) }); }
    finally { syncing = false; }
  }
  textarea.addEventListener('input', () => { if (sourceMode) loadCurrent(); }, { signal: controller.signal });
  source.addEventListener('click', () => { if (sourceMode) loadCurrent(); showSource(!sourceMode); }, { signal: controller.signal });
  textarea.form?.addEventListener('reset', () => {
    clearTimeout(resetTimer);
    // A reset event fires before its default action; a microtask can run too early.
    resetTimer = setTimeout(() => {
      if (editor.isDestroyed) return;
      bodyFormat = 'plain'; loadCurrent(); showSource(false);
    }, 0);
  }, { signal: controller.signal });
  textarea.dataset.richBodySource = ''; textarea.hidden = true; updateButtons();
  return {
    getFormat: () => bodyFormat,
    focus: () => sourceMode ? textarea.focus() : editor.commands.focus(),
    setContent(text, nextFormat = 'plain') { textarea.value = text; bodyFormat = nextFormat === 'markdown' ? 'markdown' : 'plain'; loadCurrent(); },
    destroy() { clearTimeout(resetTimer); controller.abort(); editor.destroy(); container.remove(); textarea.hidden = initialHidden; delete textarea.dataset.richBodySource; },
  };
}
