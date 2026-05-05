import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import History from '@tiptap/extension-history';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { BookOpenText, ChevronDown, ChevronRight, MapPin, Trash2, UserRound } from 'lucide-react';
import '@fontsource/geist/400.css';
import './styles.css';

const DRAFT_PREFIX = 'novel-reader-editor:draft:';
const CODEX_DRAFT_PREFIX = 'novel-reader-editor:codex-draft:';
const codexCategories = [
  { id: 'characters', label: 'Characters', type: 'character' },
  { id: 'locations', label: 'Locations', type: 'location' },
  { id: 'lore', label: 'Lore', type: 'lore' }
];

function App() {
  const [activeMenu, setActiveMenu] = useState('novel');
  const [acts, setActs] = useState([]);
  const [selectedActId, setSelectedActId] = useState('act1');
  const [novel, setNovel] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(0);
  const [status, setStatus] = useState('Loading act1.md...');
  const [dirty, setDirty] = useState(false);
  const selectedChapterRef = useRef(null);
  const [codex, setCodex] = useState(null);
  const [codexCategory, setCodexCategory] = useState('characters');
  const [selectedCodexId, setSelectedCodexId] = useState(null);
  const [codexEntry, setCodexEntry] = useState(null);
  const [codexStatus, setCodexStatus] = useState('Codex not loaded');
  const [codexDirty, setCodexDirty] = useState(false);
  const [codexSearch, setCodexSearch] = useState('');
  const [codexTagFilter, setCodexTagFilter] = useState('');
  const [codexAliasFilter, setCodexAliasFilter] = useState('');
  const [hoveredMention, setHoveredMention] = useState(null);
  const selectedCodexRef = useRef(null);

  useEffect(() => {
    let timeoutId;

    const showScrollbar = () => {
      document.documentElement.classList.add('scrollbarActive');
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        document.documentElement.classList.remove('scrollbarActive');
      }, 3000);
    };

    window.addEventListener('scroll', showScrollbar, true);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('scroll', showScrollbar, true);
      document.documentElement.classList.remove('scrollbarActive');
    };
  }, []);
  const hoverHideTimerRef = useRef(null);

  const loadActs = () => {
    return fetch('/api/acts')
      .then((response) => {
        if (!response.ok) throw new Error('Load acts failed');
        return response.json();
      })
      .then((data) => {
        setActs(data.acts ?? []);
        if (data.acts?.length && !data.acts.some((act) => act.id === selectedActId)) {
          setSelectedActId(data.acts[0].id);
        }
      })
      .catch((error) => setStatus(`Failed to load acts: ${error.message}`));
  };

  const loadNovel = (nextStatus, useLocalDraft = true, actId = selectedActId) => {
    const actFilename = `${actId}.md`;
    setStatus(`Loading ${actFilename}...`);
    return fetch(`/api/acts/${actId}`)
      .then((response) => {
        if (!response.ok) throw new Error('Load act failed');
        return response.json();
      })
      .then((data) => {
        const draft = useLocalDraft ? readLocalDraft(novelDraftKey(actId)) : null;
        if (draft?.novel) {
          setNovel(draft.novel);
          setSelectedChapter(Math.min(draft.selectedChapter ?? 0, Math.max(draft.novel.chapters.length - 1, 0)));
          setDirty(true);
          setStatus(`Loaded local draft from ${formatDateTime(draft.savedAt)}`);
          return;
        }

        setNovel(data.novel);
        setSelectedChapter((current) => Math.min(current, Math.max(data.novel.chapters.length - 1, 0)));
        setDirty(false);
        setStatus(nextStatus ?? `Loaded ${data.act?.filename ?? actFilename}`);
      })
      .catch((error) => {
        setStatus(`Failed to load: ${error.message}`);
      });
  };

  useEffect(() => {
    loadActs();
  }, []);

  useEffect(() => {
    loadNovel(undefined, true, selectedActId);
  }, [selectedActId]);

  useEffect(() => {
    if (codex) return;
    loadCodex();
  }, [codex]);

  useEffect(() => {
    if (!novel || !dirty) return;
    writeLocalDraft(novelDraftKey(selectedActId), { novel, selectedChapter, savedAt: new Date().toISOString() });
    setStatus('Saved locally');
  }, [novel, selectedChapter, dirty, selectedActId]);

  const selected = novel?.chapters[selectedChapter];
  const selectedAct = acts.find((act) => act.id === selectedActId) ?? { id: selectedActId, label: `Act ${selectedActId.replace('act', '')}`, filename: `${selectedActId}.md` };
  const chapterCount = novel?.chapters.length ?? 0;
  const codexOptions = useMemo(() => getCodexOptions(codex), [codex]);
  const codexMentionIndex = useMemo(() => buildCodexMentionIndex(codex), [codex]);
  const codexMentionMap = useMemo(() => new Map(codexMentionIndex.map((mention) => [mention.key, mention])), [codexMentionIndex]);
  const selectedChapterMentions = useMemo(() => getChapterMentionEntries(selected, codexMentionIndex), [selected, codexMentionIndex]);
  const codexVisibleEntries = useMemo(() => {
    const query = codexSearch.trim().toLowerCase();
    return (codex?.[codexCategory] ?? []).filter((entry) => {
      const matchesQuery = !query || [entry.name, entry.type, ...(entry.aliases ?? []), ...(entry.tags ?? [])].some((value) => {
        return String(value ?? '').toLowerCase().includes(query);
      });
      const matchesTag = !codexTagFilter || (entry.tags ?? []).includes(codexTagFilter);
      const matchesAlias = !codexAliasFilter || (entry.aliases ?? []).includes(codexAliasFilter);
      return matchesQuery && matchesTag && matchesAlias;
    });
  }, [codex, codexAliasFilter, codexCategory, codexSearch, codexTagFilter]);

  useEffect(() => {
    selectedChapterRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedChapter, chapterCount]);

  useEffect(() => {
    selectedCodexRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedCodexId]);

  useEffect(() => {
    if (!codex) return;
    const entries = codexVisibleEntries;
    if (!entries.length) {
      setSelectedCodexId(null);
      setCodexEntry(null);
      return;
    }

    if (!selectedCodexId || !entries.some((entry) => entry.id === selectedCodexId)) {
      setSelectedCodexId(entries[0].id);
    }
  }, [codex, codexVisibleEntries, selectedCodexId]);

  useEffect(() => {
    if (!selectedCodexId) return;
    if (!codexVisibleEntries.some((entry) => entry.id === selectedCodexId)) return;
    loadCodexEntry(codexCategory, selectedCodexId);
  }, [codexCategory, codexVisibleEntries, selectedCodexId]);

  useEffect(() => {
    if (!codexEntry || !codexDirty) return;
    writeLocalDraft(codexDraftKey(codexEntry), { entry: codexEntry, savedAt: new Date().toISOString() });
    setCodexStatus('Saved locally');
  }, [codexEntry, codexDirty]);

  const loadCodex = () => {
    setCodexStatus('Loading codex...');
    return fetch('/api/codex')
      .then((response) => response.json())
      .then((data) => {
        setCodex(data.codex);
        setCodexStatus('Loaded codex');
      })
      .catch((error) => setCodexStatus(`Failed to load codex: ${error.message}`));
  };

  const loadCodexEntry = (category, id, useLocalDraft = true) => {
    setCodexStatus('Loading entry...');
    return fetch(`/api/codex/${category}/${id}`)
      .then((response) => response.json())
      .then((data) => {
        const draft = useLocalDraft ? readLocalDraft(codexDraftKey(data.entry)) : null;
        if (draft?.entry) {
          setCodexEntry(draft.entry);
          setCodexDirty(true);
          setCodexStatus(`Loaded local draft from ${formatDateTime(draft.savedAt)}`);
          return;
        }

        setCodexEntry(data.entry);
        setCodexDirty(false);
        setCodexStatus('Loaded entry');
      })
      .catch((error) => setCodexStatus(`Failed to load entry: ${error.message}`));
  };

  const updateCodexEntry = (patch) => {
    setCodexEntry((current) => ({ ...current, ...patch }));
    setCodexDirty(true);
  };

  const changeCodexCategory = (category) => {
    setCodexCategory(category);
    setSelectedCodexId(codex?.[category]?.[0]?.id ?? null);
    setCodexEntry(null);
    setCodexDirty(false);
    setCodexStatus('Loading entry...');
  };

  const saveCodexEntry = async () => {
    setCodexStatus('Updating codex entry...');
    try {
      const response = await fetch(`/api/codex/${codexEntry.category}/${codexEntry.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry: codexEntry })
      });
      if (!response.ok) throw new Error('Update failed');
      const data = await response.json();
      localStorage.removeItem(codexDraftKey(codexEntry));
      setCodex(data.codex);
      setCodexEntry(data.entry);
      setCodexDirty(false);
      setCodexStatus('Updated codex entry');
    } catch (error) {
      setCodexStatus(`Update failed: ${error.message}`);
    }
  };

  const discardCodexChanges = () => {
    if (!codexDirty || !codexEntry) return;
    if (!window.confirm('Discard the local codex draft and reload this entry from disk?')) return;
    localStorage.removeItem(codexDraftKey(codexEntry));
    loadCodexEntry(codexEntry.category, codexEntry.id, false);
  };

  const addCodexEntry = async () => {
    const name = window.prompt('New codex entry name:', 'New Entry');
    if (!name) return;
    setCodexStatus('Creating codex entry...');
    try {
      const response = await fetch(`/api/codex/${codexCategory}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!response.ok) throw new Error('Create failed');
      const data = await response.json();
      setCodex(data.codex);
      setSelectedCodexId(data.entry.id);
      setCodexEntry(data.entry);
      setCodexDirty(false);
      setCodexStatus('Created codex entry');
    } catch (error) {
      setCodexStatus(`Create failed: ${error.message}`);
    }
  };

  const deleteCodexEntry = async () => {
    if (!codexEntry) return;
    if (!window.confirm(`Delete ${codexEntry.name}? This removes its entry folder.`)) return;
    setCodexStatus('Deleting codex entry...');
    try {
      const response = await fetch(`/api/codex/${codexEntry.category}/${codexEntry.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Delete failed');
      const data = await response.json();
      localStorage.removeItem(codexDraftKey(codexEntry));
      setCodex(data.codex);
      setSelectedCodexId(null);
      setCodexEntry(null);
      setCodexDirty(false);
      setCodexStatus('Deleted codex entry');
    } catch (error) {
      setCodexStatus(`Delete failed: ${error.message}`);
    }
  };

  const showMentionHover = (key, rect) => {
    window.clearTimeout(hoverHideTimerRef.current);
    const mention = codexMentionMap.get(key);
    if (!mention) return;
    setHoveredMention({
      mention,
      ...getClampedHoverPosition(rect)
    });
  };

  const hideMentionHover = () => {
    window.clearTimeout(hoverHideTimerRef.current);
    hoverHideTimerRef.current = window.setTimeout(() => setHoveredMention(null), 120);
  };

  const keepMentionHover = () => {
    window.clearTimeout(hoverHideTimerRef.current);
  };

  const openCodexEntry = (entry) => {
    setActiveMenu('codex');
    changeCodexCategory(entry.category);
    setSelectedCodexId(entry.id);
  };

  const compileCodex = async () => {
    setCodexStatus('Compiling codex.md...');
    try {
      const response = await fetch('/api/codex/compile', { method: 'POST' });
      if (!response.ok) throw new Error('Compile failed');
      const data = await response.json();
      setCodexStatus(`Compiled ${data.path} with ${data.count} entries`);
    } catch (error) {
      setCodexStatus(`Compile failed: ${error.message}`);
    }
  };

  const saveNovel = async () => {
    setStatus(`Saving ${selectedAct.filename}...`);
    try {
      const response = await fetch(`/api/acts/${selectedActId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel })
      });

      if (!response.ok) throw new Error('Save failed');
      const data = await response.json();
      localStorage.removeItem(novelDraftKey(selectedActId));
      setNovel(data.novel);
      setDirty(false);
      setStatus(`Updated ${data.act?.filename ?? selectedAct.filename}`);
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
    }
  };

  const addAct = async () => {
    setStatus('Creating act...');
    try {
      const response = await fetch('/api/acts', { method: 'POST' });
      if (!response.ok) throw new Error('Create failed');
      const data = await response.json();
      setActs(data.acts ?? []);
      setSelectedActId(data.act.id);
      setNovel(data.novel);
      setSelectedChapter(0);
      setDirty(false);
      setStatus(`Created ${data.act.filename}`);
    } catch (error) {
      setStatus(`Create failed: ${error.message}`);
    }
  };

  const changeAct = (actId) => {
    if (actId === selectedActId) return;
    setSelectedChapter(0);
    setSelectedActId(actId);
  };

  const updateChapter = (chapterId, patch) => {
    setNovel((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => (chapter.id === chapterId ? { ...chapter, ...patch } : chapter))
    }));
    setDirty(true);
  };

  const updateScene = (chapterId, sceneId, patch) => {
    setNovel((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => {
        if (chapter.id !== chapterId) return chapter;
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene))
        };
      })
    }));
    setDirty(true);
  };

  const addScene = (chapterId) => {
    setNovel((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => {
        if (chapter.id !== chapterId) return chapter;
        return {
          ...chapter,
          scenes: [
            ...chapter.scenes,
            {
              id: `scene-${crypto.randomUUID()}`,
              heading: `Scene ${chapter.scenes.length + 1}`,
              paragraphs: ['New scene text...']
            }
          ]
        };
      })
    }));
    setDirty(true);
  };

  const deleteScene = (chapterId, sceneId) => {
    const scene = novel.chapters.find((chapter) => chapter.id === chapterId)?.scenes.find((item) => item.id === sceneId);
    if (!window.confirm(`Delete ${scene?.heading || 'this scene'}? This change is not written to ${selectedAct.filename} until you save.`)) {
      return;
    }

    setNovel((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => {
        if (chapter.id !== chapterId) return chapter;
        return {
          ...chapter,
          scenes: chapter.scenes.filter((item) => item.id !== sceneId)
        };
      })
    }));
    setDirty(true);
  };

  const addChapter = () => {
    const chapterNumber = Math.max(0, ...novel.chapters.map((chapter) => chapter.chapterNumber)) + 1;
    const nextChapter = {
      id: `chapter-${crypto.randomUUID()}`,
      chapterNumber,
      title: 'New Chapter',
      wordCount: 2,
      scenes: [
        {
          id: `scene-${crypto.randomUUID()}`,
          heading: 'Scene 1',
          paragraphs: ['New chapter text...']
        }
      ]
    };

    setNovel((current) => ({
      ...current,
      chapters: [...current.chapters, nextChapter]
    }));
    setSelectedChapter(novel.chapters.length);
    setDirty(true);
  };

  const deleteChapter = (chapterId) => {
    const chapter = novel.chapters.find((item) => item.id === chapterId);
    if (!chapter) return;

    if (!window.confirm(`Delete Chapter ${chapter.chapterNumber}: ${chapter.title}? This change is not written to ${selectedAct.filename} until you save.`)) {
      return;
    }

    setNovel((current) => ({
      ...current,
      chapters: current.chapters.filter((item) => item.id !== chapterId)
    }));
    setSelectedChapter((current) => Math.max(0, Math.min(current, novel.chapters.length - 2)));
    setDirty(true);
  };

  const discardChanges = () => {
    if (!dirty) return;
    if (!window.confirm(`Discard the local draft and reload ${selectedAct.filename} from disk?`)) return;
    localStorage.removeItem(novelDraftKey(selectedActId));
    loadNovel('Discarded local draft', false, selectedActId);
  };

  if (!novel) {
    return <main className="loading">{status}</main>;
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <nav className="appMenu" aria-label="Main menu">
          <button
            className={activeMenu === 'novel' ? 'appMenuItem active' : 'appMenuItem'}
            onClick={() => setActiveMenu('novel')}
            type="button"
          >
            Novel
          </button>
          <button
            className={activeMenu === 'codex' ? 'appMenuItem active' : 'appMenuItem'}
            onClick={() => setActiveMenu('codex')}
            type="button"
          >
            Codex
          </button>
        </nav>

        <div className="brand">
          <span className="eyebrow">{activeMenu === 'novel' ? 'Novel' : 'Codex'}</span>
          <strong>{novel.title || 'Imported Novel'}</strong>
        </div>
        {activeMenu === 'novel' ? (
          <>
            <div className="actTabs" role="tablist" aria-label="Acts">
              {acts.map((act) => (
                <button
                  className={selectedActId === act.id ? 'actTab active' : 'actTab'}
                  key={act.id}
                  onClick={() => changeAct(act.id)}
                  type="button"
                >
                  <span>{act.label}</span>
                  <small>{act.filename}</small>
                </button>
              ))}
              <button className="button sidebarAction" onClick={addAct} type="button">
                Add act
              </button>
            </div>
            <div className="stats">
              <span>{chapterCount} chapters</span>
              <span>{formatNumber(novel.wordCount)} words</span>
              <button className="button sidebarAction" onClick={addChapter} type="button">
                Add chapter
              </button>
            </div>
            <nav className="chapterList" aria-label="Chapters">
              {novel.chapters.map((chapter, index) => (
                <button
                  className={index === selectedChapter ? 'chapterLink active' : 'chapterLink'}
                  key={chapter.id}
                  onClick={() => setSelectedChapter(index)}
                  ref={index === selectedChapter ? selectedChapterRef : null}
                  type="button"
                >
                  <span className="chapterLinkMeta">
                    <span>Chapter {chapter.chapterNumber}</span>
                    <small>{formatNumber(chapter.wordCount)} words</small>
                  </span>
                  <strong>{chapter.title}</strong>
                </button>
              ))}
            </nav>
          </>
        ) : (
          <>
            <div className="stats">
              <button className="button sidebarAction" onClick={addCodexEntry} type="button">
                Add entry
              </button>
              <button className="button sidebarAction compileAction" onClick={compileCodex} type="button">
                Compile codex.md
              </button>
            </div>
            <div className="codexTabs" role="tablist" aria-label="Codex categories">
              {codexCategories.map((category) => (
                <button
                  className={codexCategory === category.id ? `codexTab codexTab${capitalize(category.type)} active` : `codexTab codexTab${capitalize(category.type)}`}
                  key={category.id}
                  onClick={() => changeCodexCategory(category.id)}
                  type="button"
                >
                  <span className="codexTabLabel">
                    <CodexTypeIcon type={category.type} />
                    <span>{category.label}</span>
                  </span>
                  <small>{codex?.[category.id]?.length ?? 0}</small>
                </button>
              ))}
            </div>
            <div className="codexFilters">
              <input
                placeholder="Search codex..."
                value={codexSearch}
                onChange={(event) => setCodexSearch(event.target.value)}
                aria-label="Search codex"
              />
              <SearchableFilter label="tags" options={codexOptions.tags} value={codexTagFilter} onChange={setCodexTagFilter} />
              <SearchableFilter label="aliases" options={codexOptions.aliases} value={codexAliasFilter} onChange={setCodexAliasFilter} />
              {(codexSearch || codexTagFilter || codexAliasFilter) && (
                <button
                  className="button ghost filterClear"
                  onClick={() => {
                    setCodexSearch('');
                    setCodexTagFilter('');
                    setCodexAliasFilter('');
                  }}
                  type="button"
                >
                  Clear filters
                </button>
              )}
            </div>
            <nav className="chapterList" aria-label="Codex entries">
              {codexVisibleEntries.map((entry) => (
                <button
                  className={entry.id === selectedCodexId ? `chapterLink chapterLink${capitalize(entry.type)} active` : `chapterLink chapterLink${capitalize(entry.type)}`}
                  key={entry.id}
                  onClick={() => setSelectedCodexId(entry.id)}
                  ref={entry.id === selectedCodexId ? selectedCodexRef : null}
                  type="button"
                >
                  <span className="chapterLinkMeta">
                    <span className={`entryType entryType${capitalize(entry.type)}`}>
                      <CodexTypeIcon type={entry.type} />
                      <span>{entry.type}</span>
                    </span>
                    <small>{formatNumber(entry.wordCount)} words</small>
                  </span>
                  <strong>{entry.name}</strong>
                </button>
              ))}
            </nav>
          </>
        )}
      </aside>

      <section className="workspace">
        {activeMenu === 'novel' ? (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">{selectedAct.label}</p>
                <h1>{novel.title || 'Imported Novel'}</h1>
              </div>
              <div className="actions">
                <span className={dirty ? 'saveState dirty' : 'saveState'}>{status}</span>
                <button className="button secondary" disabled={!dirty} onClick={discardChanges} type="button">
                  Discard
                </button>
                <button className="button primary" disabled={!dirty} onClick={saveNovel} type="button">
                  Update {selectedAct.filename}
                </button>
              </div>
            </header>

            {selected && (
          <article className="chapterPanel">
            <div className="chapterHero">
              <div className="chapterMeta">
                <span>Chapter {selected.chapterNumber}</span>
                <span>{formatNumber(selected.wordCount)} words</span>
              </div>
              <div className="chapterTitleRow">
                <input
                  className="chapterTitle"
                  value={selected.title}
                  onChange={(event) => updateChapter(selected.id, { title: event.target.value })}
                  aria-label="Chapter title"
                />
                <button aria-label="Delete chapter" className="button ghost dangerText iconButton" onClick={() => deleteChapter(selected.id)} type="button">
                  <Trash2 size={14} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
              <CodexMentionedSection
                entries={selectedChapterMentions}
                onOpen={openCodexEntry}
                onHover={(entry, rect) => {
                  setHoveredMention({
                    mention: {
                      term: entry.name,
                      matches: [{ entry, matchType: 'name', matchedAlias: null }]
                    },
                    ...getClampedHoverPosition(rect)
                  });
                }}
                onLeave={hideMentionHover}
              />
            </div>

            {selected.scenes.map((scene) => (
              <SceneEditor
                key={scene.id}
                scene={scene}
                mentionIndex={codexMentionIndex}
                onChange={(patch) => updateScene(selected.id, scene.id, patch)}
                onDelete={() => deleteScene(selected.id, scene.id)}
                onMentionHover={showMentionHover}
                onMentionLeave={hideMentionHover}
              />
            ))}

            <button className="button secondary addScene" onClick={() => addScene(selected.id)} type="button">
              Add scene
            </button>
          </article>
            )}
          </>
        ) : (
          <CodexEditor
            category={codexCategory}
            options={codexOptions}
            dirty={codexDirty}
            entry={codexEntry}
            status={codexStatus}
            onChange={updateCodexEntry}
            onDelete={deleteCodexEntry}
            onDiscard={discardCodexChanges}
            onSave={saveCodexEntry}
          />
        )}
        {hoveredMention && <CodexMentionHoverCard data={hoveredMention} onMouseEnter={keepMentionHover} onMouseLeave={hideMentionHover} />}
      </section>
    </main>
  );
}

function SearchableFilter({ label, options, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = options.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 80);

  const selectValue = (nextValue) => {
    onChange(nextValue);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="comboBox filterCombo">
      <button className={value ? 'filterComboButton active' : 'filterComboButton'} onClick={() => setOpen((current) => !current)} type="button">
        <span>{value || `All ${label}`}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="comboList filterComboList">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
              if (event.key === 'Enter' && filtered[0]) {
                event.preventDefault();
                selectValue(filtered[0]);
              }
            }}
            placeholder={`Search ${label}...`}
          />
          <button className={!value ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => selectValue('')} type="button">
            All {label}
          </button>
          {filtered.map((option) => (
            <button
              className={option === value ? 'active' : ''}
              key={option}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectValue(option)}
              type="button"
            >
              {option}
            </button>
          ))}
          {!filtered.length && <span>No matching {label}</span>}
        </div>
      )}
    </div>
  );
}

function CodexEditor({ category, options, dirty, entry, status, onChange, onDelete, onDiscard, onSave }) {
  if (!entry) {
    return null;
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Codex</p>
          <h1>{entry.name}</h1>
        </div>
        <div className="actions">
          <span className={dirty ? 'saveState dirty' : 'saveState'}>{status}</span>
          <button className="button secondary" disabled={!dirty} onClick={onDiscard} type="button">
            Discard
          </button>
          <button className="button primary" disabled={!dirty} onClick={onSave} type="button">
            Update entry
          </button>
        </div>
      </header>

      <article className="chapterPanel">
        <div className="chapterHero codexHero">
          <div className="codexEditorGrid">
            <label>
              <span>Name</span>
              <input value={entry.name} onChange={(event) => onChange({ name: event.target.value })} />
            </label>
            <label>
              <span>Category</span>
              <input readOnly value={category} />
            </label>
            <label>
              <span>Aliases</span>
              <MultiValuePicker
                label="Aliases"
                options={options.aliases}
                values={entry.aliases}
                onChange={(aliases) => onChange({ aliases })}
              />
            </label>
            <label>
              <span>Tags</span>
              <MultiValuePicker label="Tags" options={options.tags} values={entry.tags} onChange={(tags) => onChange({ tags })} />
            </label>
          </div>

          <div className="flagRow">
            <label>
              <input
                checked={entry.alwaysIncludeInContext}
                onChange={(event) => onChange({ alwaysIncludeInContext: event.target.checked })}
                type="checkbox"
              />
              Always include
            </label>
            <label>
              <input checked={entry.doNotTrack} onChange={(event) => onChange({ doNotTrack: event.target.checked })} type="checkbox" />
              Do not track
            </label>
            <label>
              <input checked={entry.noAutoInclude} onChange={(event) => onChange({ noAutoInclude: event.target.checked })} type="checkbox" />
              No auto include
            </label>
            <button aria-label="Delete entry" className="button ghost dangerText iconButton" onClick={onDelete} type="button">
              <Trash2 size={14} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        </div>

        <CodexBodyEditor body={entry.body} entryId={entry.id} onChange={(body) => onChange({ body })} />
      </article>
    </>
  );
}

function MultiValuePicker({ label, options, values, onChange }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const available = options.filter((option) => !values.includes(option));
  const filtered = available.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 80);

  const addValue = (value) => {
    const normalized = String(value ?? '').trim();
    if (!normalized || values.includes(normalized)) return;
    onChange([...values, normalized]);
    setDraft('');
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="valuePicker">
      <div className="chipRow">
        {values.length ? (
          values.map((value) => (
            <button className="chip" key={value} onClick={() => onChange(values.filter((item) => item !== value))} type="button">
              {value}
              <span>×</span>
            </button>
          ))
        ) : (
          <span className="emptyChips">No {label.toLowerCase()}</span>
        )}
      </div>
      <div className="valuePickerControls">
        <div className="comboBox">
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
              if (event.key === 'Enter' && filtered[0]) {
                event.preventDefault();
                addValue(filtered[0]);
              }
            }}
            placeholder={`Search existing ${label.toLowerCase()}`}
            aria-label={`Search existing ${label.toLowerCase()}`}
          />
          {open && (
            <div className="comboList">
              {filtered.length ? (
                filtered.map((option) => (
                  <button key={option} onMouseDown={(event) => event.preventDefault()} onClick={() => addValue(option)} type="button">
                    {option}
                  </button>
                ))
              ) : (
                <span>No matching {label.toLowerCase()}</span>
              )}
            </div>
          )}
        </div>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addValue(draft);
            }
          }}
          placeholder={`New ${label.toLowerCase()}`}
        />
        <button className="button ghost" onClick={() => addValue(draft)} type="button">
          Add
        </button>
      </div>
    </div>
  );
}

function CodexBodyEditor({ body, entryId, onChange }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History],
    content: markdownToDoc(body),
    editorProps: {
      attributes: {
        class: 'tiptapEditor codexBodyEditor'
      }
    },
    onUpdate({ editor }) {
      onChange(docToMarkdown(editor.getJSON()));
    }
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(markdownToDoc(body), false);
  }, [editor, entryId]);

  return (
    <section className="sceneCard">
      <div className="sceneHeader">
        <div className="sceneTitleGroup">
          <span className="codexBodyTitle">Entry body</span>
        </div>
      </div>
      <EditorContent editor={editor} />
    </section>
  );
}

function SceneEditor({ scene, mentionIndex, onChange, onDelete, onMentionHover, onMentionLeave }) {
  const [expanded, setExpanded] = useState(true);
  const content = useMemo(() => paragraphsToDoc(scene.paragraphs), [scene.id]);
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History, CodexMentionExtension.configure({ mentionIndex })],
    content,
    editorProps: {
      attributes: {
        class: 'tiptapEditor'
      }
    },
    onUpdate({ editor }) {
      onChange({ paragraphs: docToParagraphs(editor.getJSON()) });
    }
  }, [mentionIndex]);

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(paragraphsToDoc(scene.paragraphs), false);
  }, [editor, scene.id]);

  return (
    <section className="sceneCard">
      <div className="sceneHeader">
        <div className="sceneTitleGroup">
          <button aria-label={expanded ? 'Hide scene' : 'Show scene'} className="collapseButton" onClick={() => setExpanded((current) => !current)} type="button">
            {expanded ? <ChevronDown size={14} strokeWidth={2.2} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2.2} aria-hidden="true" />}
          </button>
          <input
            value={scene.heading}
            onChange={(event) => onChange({ heading: event.target.value })}
            aria-label="Scene heading"
          />
          {!expanded && <span className="sceneSummary">{scene.paragraphs.length} paragraphs</span>}
        </div>
        <div className="sceneActions">
          <button aria-label="Delete scene" className="button ghost dangerText iconButton" onClick={onDelete} type="button">
            <Trash2 size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded && (
        <div
          onMouseOver={(event) => {
            const target = event.target.closest?.('.codexMention');
            if (!target) return;
            onMentionHover(target.dataset.codexKey, target.getBoundingClientRect());
          }}
          onMouseLeave={onMentionLeave}
        >
          <EditorContent editor={editor} />
        </div>
      )}
    </section>
  );
}

function CodexMentionHoverCard({ data, onMouseEnter, onMouseLeave }) {
  const { mention, x, y } = data;

  return (
    <aside className="codexHoverCard" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ left: x, top: y }}>
      <div className="codexHoverHeader">
        <span className="eyebrow">Codex mention</span>
        <h2>{mention.term}</h2>
        <p>{mention.matches.length} {mention.matches.length === 1 ? 'match' : 'matches'}</p>
      </div>
      <div className="codexHoverEntries">
        {mention.matches.map((match) => (
          <section className="codexHoverEntry" key={`${match.entry.category}:${match.entry.id}:${match.matchType}`}>
            <div className="codexHoverEntryHeader">
              <div>
                <h3>{match.entry.name}</h3>
                <p className={`entryType entryType${capitalize(match.entry.type)}`}>{match.entry.type}</p>
              </div>
              <span className="matchBadge">{match.matchType === 'alias' ? `alias "${match.matchedAlias}"` : 'name'}</span>
            </div>

            <div className="metadataStack">
              <span><strong>Source:</strong> <code>{match.entry.path}</code></span>
              <span>
                <strong>Context:</strong> alwaysIncludeInContext={String(match.entry.alwaysIncludeInContext)}, doNotTrack={String(match.entry.doNotTrack)}, noAutoInclude={String(match.entry.noAutoInclude)}
              </span>
            </div>

            <ChipGroup label="Aliases" values={match.entry.aliases} />
            <ChipGroup label="Tags" values={match.entry.tags} />

            <div className="codexHoverBody">
              {match.entry.body || 'No body content.'}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

function ChipGroup({ label, values }) {
  return (
    <div className="hoverChipGroup">
      <strong>{label}</strong>
      <div className="chipRow">
        {values?.length ? values.map((value) => <span className="staticChip" key={value}>{value}</span>) : <span className="emptyChips">None</span>}
      </div>
    </div>
  );
}

function CodexMentionedSection({ entries, onOpen, onHover, onLeave }) {
  return (
    <section className="chapterCodexMentions">
      <div className="chapterCodexHeader">
        <h2>Codex Mentioned</h2>
        <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
      </div>
      {entries.length ? (
        <div className="chapterMentionChips">
          {entries.map((entry) => (
            <button
              className={`chapterMentionChip chapterMentionChip${capitalize(entry.type)}`}
              key={`${entry.category}:${entry.id}`}
              onClick={() => onOpen(entry)}
              onMouseEnter={(event) => onHover(entry, event.currentTarget.getBoundingClientRect())}
              onMouseLeave={onLeave}
              type="button"
            >
              <CodexTypeIcon type={entry.type} />
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p>No codex entries detected in this chapter.</p>
      )}
    </section>
  );
}

function CodexTypeIcon({ type }) {
  const props = { size: 14, strokeWidth: 2.2, 'aria-hidden': true };
  if (type === 'location') return <MapPin {...props} />;
  if (type === 'lore') return <BookOpenText {...props} />;
  return <UserRound {...props} />;
}

function paragraphsToDoc(paragraphs) {
  return {
    type: 'doc',
    content: (paragraphs.length ? paragraphs : ['']).map((paragraph) => ({
      type: 'paragraph',
      content: paragraph ? [{ type: 'text', text: paragraph }] : []
    }))
  };
}

function docToParagraphs(doc) {
  return (doc.content ?? [])
    .filter((node) => node.type === 'paragraph')
    .map((node) => (node.content ?? []).map((child) => child.text ?? '').join('').trim())
    .filter(Boolean);
}

function markdownToDoc(markdown) {
  const paragraphs = String(markdown ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphsToDoc(paragraphs.length ? paragraphs : ['']);
}

function docToMarkdown(doc) {
  return docToParagraphs(doc).join('\n\n');
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const CodexMentionExtension = Extension.create({
  name: 'codexMention',

  addOptions() {
    return {
      mentionIndex: []
    };
  },

  addProseMirrorPlugins() {
    const mentionIndex = this.options.mentionIndex ?? [];

    return [
      new Plugin({
        key: new PluginKey('codexMention'),
        props: {
          decorations(state) {
            if (!mentionIndex.length) return DecorationSet.empty;

            const decorations = [];
            state.doc.descendants((node, position) => {
              if (!node.isText || !node.text) return;

              for (const match of findMentionMatches(node.text, mentionIndex)) {
                decorations.push(
                  Decoration.inline(position + match.from, position + match.to, {
                    class: getMentionClass(match.mention),
                    'data-codex-key': match.mention.key,
                    title: match.mention.term
                  })
                );
              }
            });

            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

function buildCodexMentionIndex(codex) {
  const termMap = new Map();

  for (const entries of Object.values(codex ?? {})) {
    for (const entry of entries ?? []) {
      addMentionTerm(termMap, entry.name, entry, 'name');
      for (const alias of entry.aliases ?? []) {
        addMentionTerm(termMap, alias, entry, 'alias');
      }
    }
  }

  return [...termMap.entries()]
    .map(([term, matches]) => ({
      key: stableMentionKey(term),
      term,
      matches: matches.sort((a, b) => {
        if (a.matchType !== b.matchType) return a.matchType === 'name' ? -1 : 1;
        return a.entry.name.localeCompare(b.entry.name);
      })
    }))
    .sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
}

function addMentionTerm(termMap, term, entry, matchType) {
  const normalized = String(term ?? '').trim();
  if (!normalized) return;

  const matches = termMap.get(normalized) ?? [];
  const exists = matches.some((match) => match.entry.id === entry.id && match.entry.category === entry.category && match.matchType === matchType);
  if (!exists) {
    matches.push({
      matchType,
      matchedAlias: matchType === 'alias' ? normalized : null,
      entry
    });
  }
  termMap.set(normalized, matches);
}

function findMentionMatches(text, mentionIndex) {
  const matches = [];
  const occupied = Array(text.length).fill(false);

  for (const mention of mentionIndex) {
    let from = text.indexOf(mention.term);
    while (from !== -1) {
      const to = from + mention.term.length;
      const overlaps = occupied.slice(from, to).some(Boolean);
      if (!overlaps && hasMentionBoundary(text, from, to)) {
        matches.push({ from, to, mention });
        occupied.fill(true, from, to);
      }
      from = text.indexOf(mention.term, from + 1);
    }
  }

  return matches.sort((a, b) => a.from - b.from);
}

function getChapterMentionEntries(chapter, mentionIndex) {
  if (!chapter || !mentionIndex.length) return [];
  const byKey = new Map();

  for (const scene of chapter.scenes ?? []) {
    const text = (scene.paragraphs ?? []).join('\n\n');
    for (const match of findMentionMatches(text, mentionIndex)) {
      for (const item of match.mention.matches) {
        byKey.set(`${item.entry.category}:${item.entry.id}`, item.entry);
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

function getClampedHoverPosition(rect) {
  const margin = 14;
  const cardWidth = Math.min(540, window.innerWidth - margin * 2);
  const cardMaxHeight = window.innerHeight * 0.7;
  const maxY = Math.max(margin, window.innerHeight - cardMaxHeight - margin);
  const gap = 12;
  const rightX = rect.right + gap;
  const leftX = rect.left - cardWidth - gap;
  const x = rightX + cardWidth <= window.innerWidth - margin ? rightX : leftX >= margin ? leftX : Math.max(margin, Math.min(rect.left, window.innerWidth - cardWidth - margin));
  const sideY = rect.top - 18;
  const belowY = rect.bottom + gap;
  const y = (rightX + cardWidth <= window.innerWidth - margin || leftX >= margin)
    ? sideY
    : belowY + cardMaxHeight > window.innerHeight - margin
      ? rect.top - cardMaxHeight - gap
      : belowY;

  return {
    x,
    y: Math.max(margin, Math.min(y, maxY))
  };
}

function hasMentionBoundary(text, from, to) {
  const before = text[from - 1];
  const after = text[to];
  const startsWord = isWordLike(text[from]);
  const endsWord = isWordLike(text[to - 1]);
  return !(startsWord && isWordLike(before)) && !(endsWord && isWordLike(after));
}

function isWordLike(value) {
  return Boolean(value && /[\p{L}\p{N}_'-]/u.test(value));
}

function getMentionClass(mention) {
  const types = new Set(mention.matches.map((match) => match.entry.type));
  const base = ['codexMention'];
  if (mention.matches.length > 1) base.push('codexMentionMultiple');
  if (types.size === 1) base.push(`codexMention${capitalize([...types][0])}`);
  return base.join(' ');
}

function stableMentionKey(term) {
  let hash = 0;
  for (let index = 0; index < term.length; index += 1) {
    hash = (hash * 31 + term.charCodeAt(index)) >>> 0;
  }
  return `mention-${hash.toString(36)}`;
}

function capitalize(value) {
  return String(value ?? '').charAt(0).toUpperCase() + String(value ?? '').slice(1);
}

function getCodexOptions(codex) {
  const aliases = new Set();
  const tags = new Set();

  for (const entries of Object.values(codex ?? {})) {
    for (const entry of entries ?? []) {
      for (const alias of entry.aliases ?? []) aliases.add(alias);
      for (const tag of entry.tags ?? []) tags.add(tag);
    }
  }

  return {
    aliases: [...aliases].sort((a, b) => a.localeCompare(b)),
    tags: [...tags].sort((a, b) => a.localeCompare(b))
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function codexDraftKey(entry) {
  return `${CODEX_DRAFT_PREFIX}${entry.category}:${entry.id}`;
}

function novelDraftKey(actId) {
  return `${DRAFT_PREFIX}${actId}`;
}

function readLocalDraft(key = novelDraftKey('act1')) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function writeLocalDraft(keyOrDraft, maybeDraft) {
  const key = maybeDraft ? keyOrDraft : novelDraftKey('act1');
  const draft = maybeDraft ?? keyOrDraft;
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch (error) {
    console.error('Failed to save local draft', error);
  }
}

function formatDateTime(value) {
  if (!value) return 'browser storage';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

createRoot(document.getElementById('root')).render(<App />);
