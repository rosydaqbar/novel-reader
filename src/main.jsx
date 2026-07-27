import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import History from '@tiptap/extension-history';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Book, BookOpenText, ChevronDown, ChevronRight, MapPin, Trash2, UserRound } from 'lucide-react';
import {
  compileCodex as compileLocalCodex,
  createVolume as createLocalVolume,
  createCodexEntry as createLocalCodexEntry,
  createStarterNovel,
  deleteCodexEntry as deleteLocalCodexEntry,
  deleteVolume as deleteLocalVolume,
  ensureCodexFolders,
  flattenCodexEntries,
  hasHandlePermission,
  listVolumes as listLocalVolumes,
  listCodexEntries as listLocalCodexEntries,
  loadRecentDatasourceHandle,
  migrateLegacyActsToVolumes,
  openDatasourceFolder,
  readVolume,
  readCodexEntry,
  recoverCodexFromCompiledFile,
  saveRecentDatasourceHandle,
  supportsLocalFiles,
  verifyHandlePermission,
  writeVolume,
  writeCodexEntry as writeLocalCodexEntry
} from './localDatasource.js';
import '@fontsource/geist/400.css';
import './styles.css';

const DRAFT_PREFIX = 'novel-reader-editor:draft:';
const CODEX_DRAFT_PREFIX = 'novel-reader-editor:codex-draft:';
const UI_STATE_KEY = 'novel-reader-editor:ui-state';
const codexCategories = [
  { id: 'characters', label: 'Characters', type: 'character' },
  { id: 'locations', label: 'Locations', type: 'location' },
  { id: 'lore', label: 'Lore', type: 'lore' }
];

function RootShell() {
  return (
    <>
      <InterfaceBackground />
      <App />
    </>
  );
}

function InterfaceBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const context = canvas.getContext('2d');
    if (!context) return undefined;

    let frameId;
    let width = 0;
    let height = 0;
    let time = 0;
    const pointer = { x: 0, y: 0 };
    const spacing = 35;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const movePointer = (event) => {
      pointer.x = (event.clientX / window.innerWidth - 0.5) * 10;
      pointer.y = (event.clientY / window.innerHeight - 0.5) * 10;
    };

    const draw = () => {
      time += 0.006;
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#161618';
      context.fillRect(0, 0, width, height);

      const pulse = 0.45 + Math.sin(time) * 0.12;
      const centerX = width / 2;
      const centerY = height / 2;

      for (let y = spacing / 2; y < height; y += spacing) {
        for (let x = spacing / 2; x < width; x += spacing) {
          const dx = x - centerX;
          const dy = y - centerY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const fade = Math.max(0, 1 - distance / Math.max(width, height));
          const driftX = Math.sin(time + y * 0.012) * 1.4 + pointer.x * fade;
          const driftY = Math.cos(time + x * 0.012) * 1.4 + pointer.y * fade;
          const alpha = Math.min(0.3, 0.035 + fade * pulse * 0.16);

          context.beginPath();
          context.fillStyle = `rgba(93, 255, 173, ${alpha})`;
          context.arc(x + driftX, y + driftY, 1.1 + fade * 0.7, 0, Math.PI * 2);
          context.fill();
        }
      }

      frameId = window.requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', movePointer);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', movePointer);
    };
  }, []);

  return <canvas ref={canvasRef} className="interfaceBackdrop" aria-hidden="true" />;
}

function App() {
  const savedUiState = useMemo(() => readUiState(), []);
  const [activeMenu, setActiveMenu] = useState(savedUiState.activeMenu ?? 'novel');
  const [datasourceHandle, setDatasourceHandle] = useState(null);
  const [recentDatasourceHandle, setRecentDatasourceHandle] = useState(null);
  const [volumes, setVolumes] = useState([]);
  const [volumesLoaded, setVolumesLoaded] = useState(false);
  const [selectedVolumeId, setSelectedVolumeId] = useState(savedUiState.selectedVolumeId ?? convertActIdToVolumeId(savedUiState.selectedActId) ?? 'volume1');
  const [novel, setNovel] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(savedUiState.selectedChapter ?? 0);
  const [status, setStatus] = useState(supportsLocalFiles() ? 'Open or create a local datasource folder' : 'This app currently supports Chromium browsers only.');
  const [dirty, setDirty] = useState(false);
  const selectedChapterRef = useRef(null);
  const [codex, setCodex] = useState(null);
  const [codexCategory, setCodexCategory] = useState(savedUiState.codexCategory ?? 'characters');
  const [selectedCodexId, setSelectedCodexId] = useState(savedUiState.selectedCodexId ?? null);
  const [codexEntry, setCodexEntry] = useState(null);
  const [codexStatus, setCodexStatus] = useState('Codex not loaded');
  const [codexDirty, setCodexDirty] = useState(false);
  const [codexSearch, setCodexSearch] = useState('');
  const [codexTagFilter, setCodexTagFilter] = useState('');
  const [codexAliasFilter, setCodexAliasFilter] = useState('');
  const [hoveredMention, setHoveredMention] = useState(null);
  const [chapterMentionDetail, setChapterMentionDetail] = useState(null);
  const [pendingParagraphAnchor, setPendingParagraphAnchor] = useState(null);
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

  useEffect(() => {
    if (!supportsLocalFiles()) return;
    let cancelled = false;

    loadRecentDatasourceHandle()
      .then(async (handle) => {
        if (!handle || cancelled) return;
        setRecentDatasourceHandle(handle);
        if (!(await hasHandlePermission(handle))) {
          setStatus('Recent datasource needs permission. Click Restore recent datasource to continue.');
          return;
        }
        await activateDatasource(handle, 'Restored recent datasource');
      })
      .catch((error) => setStatus(`Could not restore recent datasource: ${error.message}`));

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeUiState({ activeMenu, selectedVolumeId, selectedChapter, codexCategory, selectedCodexId });
  }, [activeMenu, selectedVolumeId, selectedChapter, codexCategory, selectedCodexId]);

  useEffect(() => {
    setChapterMentionDetail(null);
  }, [activeMenu, selectedCodexId, selectedVolumeId]);

  useEffect(() => {
    if (activeMenu !== 'novel' || !pendingParagraphAnchor) return;
    let frameId;
    let highlightTimer;
    let attempts = 0;
    let anchoredParagraph;

    const findParagraph = () => {
      const sceneCards = [...document.querySelectorAll('.sceneCard[data-scene-index]')];
      const sceneCard = sceneCards.find((node) => {
        if (pendingParagraphAnchor.sceneId) return node.dataset.sceneId === pendingParagraphAnchor.sceneId;
        return Number(node.dataset.sceneIndex) === pendingParagraphAnchor.sceneIndex;
      });
      const paragraph = sceneCard?.querySelectorAll('.tiptapEditor > p')[pendingParagraphAnchor.paragraphIndex];

      if (!paragraph && attempts < 30) {
        attempts += 1;
        frameId = window.requestAnimationFrame(findParagraph);
        return;
      }

      if (!paragraph) {
        setPendingParagraphAnchor(null);
        return;
      }

      paragraph.classList.add('paragraphAnchorTarget');
      anchoredParagraph = paragraph;
      paragraph.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightTimer = window.setTimeout(() => {
        paragraph.classList.remove('paragraphAnchorTarget');
        setPendingParagraphAnchor(null);
      }, 1800);
    };

    frameId = window.requestAnimationFrame(findParagraph);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(highlightTimer);
      anchoredParagraph?.classList.remove('paragraphAnchorTarget');
    };
  }, [activeMenu, pendingParagraphAnchor, selectedChapter]);

  const loadVolumes = async (handle = datasourceHandle) => {
    if (!handle) return;
    try {
      const nextVolumes = await listLocalVolumes(handle);
      setVolumes(nextVolumes);
      setVolumesLoaded(true);
      if (nextVolumes.length && !nextVolumes.some((volume) => volume.id === selectedVolumeId)) setSelectedVolumeId(nextVolumes[0].id);
      if (!nextVolumes.length) {
        setNovel(null);
        setDirty(false);
        setStatus('No novel found in this datasource');
      }
    } catch (error) {
      setVolumesLoaded(true);
      setStatus(`Failed to load volumes: ${error.message}`);
    }
  };

  const loadNovel = async (nextStatus, useLocalDraft = true, volumeId = selectedVolumeId, handle = datasourceHandle) => {
    if (!handle) return;
    const volumeFilename = `${volumeId}.md`;
    setStatus(`Loading ${volumeFilename}...`);
    try {
      const data = await readVolume(handle, volumeId);
      const draft = useLocalDraft ? readLocalDraft(novelDraftKey(volumeId)) : null;
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
      setStatus(nextStatus ?? `Loaded ${data.volume?.filename ?? volumeFilename}`);
    } catch (error) {
      setStatus(`Failed to load: ${error.message}`);
    }
  };

  useEffect(() => {
    if (!volumesLoaded || !volumes.length) return;
    loadNovel(undefined, true, selectedVolumeId);
  }, [volumesLoaded, volumes.length, selectedVolumeId, datasourceHandle]);

  useEffect(() => {
    if (!datasourceHandle || codex) return;
    loadCodex();
  }, [codex, datasourceHandle]);

  useEffect(() => {
    if (!novel || !dirty) return;
    writeLocalDraft(novelDraftKey(selectedVolumeId), { novel, selectedChapter, savedAt: new Date().toISOString() });
    setStatus('Saved locally');
  }, [novel, selectedChapter, dirty, selectedVolumeId]);

  const selected = novel?.chapters[selectedChapter];
  const selectedVolume = volumes.find((volume) => volume.id === selectedVolumeId) ?? { id: selectedVolumeId, label: `Volume ${selectedVolumeId.replace('volume', '')}`, filename: `${selectedVolumeId}.md` };
  const legacyVolumes = volumes.filter((volume) => volume.legacy);
  const selectedCodexCategory = codexCategories.find((category) => category.id === codexCategory) ?? codexCategories[0];
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

  const loadCodexWithRecovery = async (handle) => {
    const data = await listLocalCodexEntries(handle);
    if (flattenCodexEntries(data).length) return { codex: data, recovered: 0 };

    const recovery = await recoverCodexFromCompiledFile(handle);
    return { codex: recovery.codex, recovered: recovery.count };
  };

  const loadCodex = async () => {
    if (!datasourceHandle) return;
    setCodexStatus('Loading codex...');
    try {
      const data = await loadCodexWithRecovery(datasourceHandle);
      setCodex(data.codex);
      setCodexStatus(data.recovered > 0 ? `Recovered ${data.recovered} codex entries from codex.md` : 'Loaded codex');
    } catch (error) {
      setCodexStatus(`Failed to load codex: ${error.message}`);
    }
  };

  const loadCodexEntry = (category, id, useLocalDraft = true) => {
    if (!datasourceHandle) return Promise.resolve();
    setCodexStatus('Loading entry...');
    return readCodexEntry(datasourceHandle, category, id)
      .then((entry) => {
        const draft = useLocalDraft ? readLocalDraft(codexDraftKey(entry)) : null;
        if (draft?.entry) {
          setCodexEntry(draft.entry);
          setCodexDirty(true);
          setCodexStatus(`Loaded local draft from ${formatDateTime(draft.savedAt)}`);
          return;
        }

        setCodexEntry(entry);
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
    if (category === codexCategory) return;
    setCodexCategory(category);
    setSelectedCodexId(codex?.[category]?.[0]?.id ?? null);
    setCodexEntry(null);
    setCodexDirty(false);
    setCodexStatus('Loading entry...');
  };

  const saveCodexEntry = async () => {
    setCodexStatus('Updating codex entry...');
    try {
      const entry = await writeLocalCodexEntry(datasourceHandle, codexEntry);
      const nextCodex = await listLocalCodexEntries(datasourceHandle);
      localStorage.removeItem(codexDraftKey(codexEntry));
      setCodex(nextCodex);
      setCodexEntry(entry);
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
      const entry = await createLocalCodexEntry(datasourceHandle, codexCategory, name);
      const nextCodex = await listLocalCodexEntries(datasourceHandle);
      setCodex(nextCodex);
      setSelectedCodexId(entry.id);
      setCodexEntry(entry);
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
      await deleteLocalCodexEntry(datasourceHandle, codexEntry.category, codexEntry.id);
      const nextCodex = await listLocalCodexEntries(datasourceHandle);
      localStorage.removeItem(codexDraftKey(codexEntry));
      setCodex(nextCodex);
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

  const activateDatasource = async (handle, nextStatus = 'Loaded datasource') => {
    await ensureCodexFolders(handle);
    await saveRecentDatasourceHandle(handle);
    const nextVolumes = await listLocalVolumes(handle);
    const codexLoad = await loadCodexWithRecovery(handle);
    const nextVolumeId = nextVolumes.some((volume) => volume.id === selectedVolumeId) ? selectedVolumeId : nextVolumes[0]?.id;

    setDatasourceHandle(handle);
    setCodex(codexLoad.codex);
    setCodexStatus(codexLoad.recovered > 0 ? `Recovered ${codexLoad.recovered} codex entries from codex.md` : 'Loaded codex');
    setVolumes(nextVolumes);
    setVolumesLoaded(true);

    if (nextVolumeId) {
      const volume = nextVolumes.find((item) => item.id === nextVolumeId);
      setSelectedVolumeId(nextVolumeId);
      await loadNovel(`${nextStatus}: ${volume?.filename ?? `${nextVolumeId}.md`}`, true, nextVolumeId, handle);
    } else {
      setNovel(null);
      setDirty(false);
      setStatus('No novel found in this datasource');
    }
  };

  const openDatasource = async () => {
    setStatus('Opening local datasource...');
    try {
      const handle = await openDatasourceFolder();
      await activateDatasource(handle, 'Loaded datasource');
    } catch (error) {
      setStatus(`Open failed: ${error.message}`);
    }
  };

  const restoreRecentDatasource = async () => {
    if (!recentDatasourceHandle) return;
    setStatus('Restoring recent datasource...');
    try {
      if (!(await verifyHandlePermission(recentDatasourceHandle))) {
        setStatus('Folder permission was not granted.');
        return;
      }
      await activateDatasource(recentDatasourceHandle, 'Restored recent datasource');
    } catch (error) {
      setStatus(`Restore failed: ${error.message}`);
    }
  };

  const createDatasource = async () => {
    setStatus('Choose an empty folder or datasource folder...');
    try {
      const handle = await openDatasourceFolder();
      setDatasourceHandle(handle);
      await saveRecentDatasourceHandle(handle);
      await createNovel(handle);
    } catch (error) {
      setStatus(`Create failed: ${error.message}`);
    }
  };

  const openCodexEntry = (entry) => {
    setActiveMenu('codex');
    changeCodexCategory(entry.category);
    setSelectedCodexId(entry.id);
  };

  const hoverChapterEntry = (chapter, rect) => {
    setHoveredMention({
      mention: {
        term: `Chapter ${chapter.chapterNumber}`,
        matches: [{ matchType: 'chapter', matchedAlias: null, chapter }]
      },
      ...getClampedHoverPosition(rect)
    });
  };

  const openChapterMentionDetail = (entry, chapter) => {
    const paragraphs = getEntryChapterMentionParagraphs(entry, chapter);
    setChapterMentionDetail({ chapterId: chapter.id, chapterNumber: chapter.chapterNumber, title: chapter.title, paragraphs });
  };

  const goToChapterParagraph = (target) => {
    const chapterIndex = novel.chapters.findIndex((chapter) => {
      if (target.chapterId) return chapter.id === target.chapterId;
      return chapter.chapterNumber === target.chapterNumber;
    });
    if (chapterIndex < 0) return;
    setHoveredMention(null);
    setPendingParagraphAnchor(target);
    setSelectedChapter(chapterIndex);
    setActiveMenu('novel');
  };

  const compileCodex = async () => {
    setCodexStatus('Compiling codex.md...');
    try {
      const data = await compileLocalCodex(datasourceHandle);
      setCodexStatus(`Compiled ${data.path} with ${data.count} entries`);
    } catch (error) {
      setCodexStatus(`Compile failed: ${error.message}`);
    }
  };

  const saveNovel = async () => {
    setStatus(`Saving ${selectedVolume.filename}...`);
    try {
      const data = await writeVolume(datasourceHandle, selectedVolumeId, novel, flattenCodexEntries(codex));
      localStorage.removeItem(novelDraftKey(selectedVolumeId));
      setNovel(data.novel);
      setDirty(false);
      setStatus(`Updated ${data.volume?.filename ?? selectedVolume.filename}`);
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
    }
  };

  const addVolume = async () => {
    setStatus('Creating volume...');
    try {
      const volume = await createLocalVolume(datasourceHandle, novel?.title || 'Untitled Novel');
      const nextVolumes = await listLocalVolumes(datasourceHandle);
      const data = await readVolume(datasourceHandle, volume.id);
      setVolumes(nextVolumes);
      setSelectedVolumeId(volume.id);
      setNovel(data.novel);
      setSelectedChapter(0);
      setDirty(false);
      setStatus(`Created ${volume.filename}`);
    } catch (error) {
      setStatus(`Create failed: ${error.message}`);
    }
  };

  const deleteVolume = async () => {
    if (!selectedVolume) return;
    if (!window.confirm(`Delete ${selectedVolume.filename}? This removes the markdown file from your local datasource folder.`)) return;

    setStatus(`Deleting ${selectedVolume.filename}...`);
    try {
      await deleteLocalVolume(datasourceHandle, selectedVolume);
      localStorage.removeItem(novelDraftKey(selectedVolume.id));
      const nextVolumes = await listLocalVolumes(datasourceHandle);
      setVolumes(nextVolumes);

      if (!nextVolumes.length) {
        setNovel(null);
        setDirty(false);
        setVolumesLoaded(true);
        setStatus(`Deleted ${selectedVolume.filename}`);
        return;
      }

      const currentIndex = volumes.findIndex((volume) => volume.id === selectedVolume.id);
      const nextVolume = nextVolumes[Math.max(0, Math.min(currentIndex, nextVolumes.length - 1))];
      setSelectedVolumeId(nextVolume.id);
      setSelectedChapter(0);
      await loadNovel(`Deleted ${selectedVolume.filename}`, false, nextVolume.id);
    } catch (error) {
      setStatus(`Delete failed: ${error.message}`);
    }
  };

  const migrateLegacyVolumes = async () => {
    if (!legacyVolumes.length) return;
    const count = legacyVolumes.length;
    if (!window.confirm(`Migrate ${count} legacy act ${count === 1 ? 'file' : 'files'} into volumes/? This copies act*.md to volume*.md and keeps the old files untouched.`)) return;

    setStatus('Migrating legacy act files...');
    try {
      const result = await migrateLegacyActsToVolumes(datasourceHandle);
      const nextVolumes = await listLocalVolumes(datasourceHandle);
      setVolumes(nextVolumes);
      const nextVolumeId = nextVolumes.some((volume) => volume.id === selectedVolumeId) ? selectedVolumeId : nextVolumes[0]?.id ?? 'volume1';
      setSelectedVolumeId(nextVolumeId);
      await loadNovel(`Migrated ${result.migrated} ${result.migrated === 1 ? 'file' : 'files'} to volumes/`, false, nextVolumeId);
    } catch (error) {
      setStatus(`Migration failed: ${error.message}`);
    }
  };

  const createNovel = async (handle = datasourceHandle) => {
    const title = window.prompt('Novel name:', 'Untitled Novel')?.trim();
    if (!title) return;

    setStatus('Creating novel...');
    try {
      await saveRecentDatasourceHandle(handle);
      await createStarterNovel(handle, title);
      await ensureCodexFolders(handle);
      const nextVolumes = await listLocalVolumes(handle);
      const data = await readVolume(handle, 'volume1');
      const nextCodex = await listLocalCodexEntries(handle);
      setVolumes(nextVolumes);
      setVolumesLoaded(true);
      setCodex(nextCodex);
      setSelectedVolumeId('volume1');
      setNovel(data.novel);
      setSelectedChapter(0);
      setDirty(false);
      setStatus('Created volume1.md');
    } catch (error) {
      setStatus(`Create failed: ${error.message}`);
    }
  };

  const changeVolume = (volumeId) => {
    if (volumeId === selectedVolumeId) return;
    setSelectedChapter(0);
    setSelectedVolumeId(volumeId);
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
    if (!window.confirm(`Delete ${scene?.heading || 'this scene'}? This change is not written to ${selectedVolume.filename} until you save.`)) {
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

    if (!window.confirm(`Delete Chapter ${chapter.chapterNumber}: ${chapter.title}? This change is not written to ${selectedVolume.filename} until you save.`)) {
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
    if (!window.confirm(`Discard the local draft and reload ${selectedVolume.filename} from disk?`)) return;
    localStorage.removeItem(novelDraftKey(selectedVolumeId));
    loadNovel('Discarded local draft', false, selectedVolumeId);
  };

  if (!datasourceHandle) {
    return <WelcomeEmptyState onCreate={createDatasource} onOpen={openDatasource} onRestore={recentDatasourceHandle ? restoreRecentDatasource : null} status={status} supported={supportsLocalFiles()} />;
  }

  if (!novel && volumesLoaded && !volumes.length) {
    return <WelcomeEmptyState onCreate={() => createNovel(datasourceHandle)} status={status} supported={supportsLocalFiles()} />;
  }

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
            <div className="volumeTabs" role="tablist" aria-label="Volumes">
              {volumes.map((volume) => (
                <button
                  className={selectedVolumeId === volume.id ? 'volumeTab active' : 'volumeTab'}
                  key={volume.id}
                  onClick={() => changeVolume(volume.id)}
                  type="button"
                >
                  <span className="volumeTabLabel">
                    <Book size={15} strokeWidth={2.1} aria-hidden="true" />
                    <span>{volume.label}</span>
                  </span>
                  <small>{volume.filename}</small>
                </button>
              ))}
              <button className="button sidebarAction" onClick={addVolume} type="button">
                Add volume
              </button>
            </div>
            <div className="stats">
              <span>{chapterCount} chapters</span>
              <span>{formatNumber(novel.wordCount)} words</span>
              <button className="button sidebarAction" onClick={addChapter} type="button">
                Add chapter
              </button>
            </div>
            {legacyVolumes.length > 0 && (
              <div className="migrationNotice">
                <strong>Legacy act files detected</strong>
                <p>{legacyVolumes.length} old act {legacyVolumes.length === 1 ? 'file is' : 'files are'} still being read from `acts/`. Migrate them to `volumes/` when you are ready.</p>
                <button className="button secondary" onClick={migrateLegacyVolumes} type="button">
                  Migrate to volumes
                </button>
              </div>
            )}
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
              <button className="button sidebarAction" onClick={addCodexEntry} type="button">
                Add entry
              </button>
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
              {codexVisibleEntries.length ? (
                codexVisibleEntries.map((entry) => (
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
                ))
              ) : (
                <div className="emptyMenuState">
                  <p>No {selectedCodexCategory.label.toLowerCase()} entries yet.</p>
                  <button className="button sidebarAction" onClick={addCodexEntry} type="button">
                    Create {selectedCodexCategory.type} entry
                  </button>
                </div>
              )}
            </nav>
          </>
        )}
      </aside>

      <section className="workspace">
        {activeMenu === 'novel' ? (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">{selectedVolume.label}</p>
                <h1>{novel.title || 'Imported Novel'}</h1>
              </div>
              <div className="actions">
                <span className={dirty ? 'saveState dirty' : 'saveState'}>{status}</span>
                <button className="button secondary" disabled={!dirty} onClick={discardChanges} type="button">
                  Discard
                </button>
                <button className="button secondary dangerText" onClick={deleteVolume} type="button">
                  Remove volume
                </button>
                <button className="button primary" disabled={!dirty} onClick={saveNovel} type="button">
                  Update {selectedVolume.filename}
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
                <button aria-label="Delete chapter" className="button secondary dangerText iconButton" onClick={() => deleteChapter(selected.id)} type="button">
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

            {selected.scenes.map((scene, sceneIndex) => (
              <SceneEditor
                key={scene.id}
                scene={scene}
                sceneIndex={sceneIndex}
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
          <div className={chapterMentionDetail ? 'codexWorkspaceLayout hasChapterMentionDetail' : 'codexWorkspaceLayout'}>
            <div className="codexWorkspaceMain">
              <CodexEditor
                category={codexCategory}
                options={codexOptions}
                dirty={codexDirty}
                entry={codexEntry}
                status={codexStatus}
                novel={novel}
                mentionIndex={codexMentionIndex}
                chapterMentionDetail={chapterMentionDetail}
                onChapterHover={hoverChapterEntry}
                onChapterDetailOpen={(chapter) => openChapterMentionDetail(codexEntry, chapter)}
                onChapterDetailClose={() => setChapterMentionDetail(null)}
                onChapterParagraphOpen={goToChapterParagraph}
                onMentionHover={showMentionHover}
                onEntryOpen={openCodexEntry}
                onMentionLeave={hideMentionHover}
                onChange={updateCodexEntry}
                onDelete={deleteCodexEntry}
                onDiscard={discardCodexChanges}
                onCreate={addCodexEntry}
                onSave={saveCodexEntry}
              />
            </div>
          </div>
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

function CodexEditor({ category, options, dirty, entry, status, novel, mentionIndex, chapterMentionDetail, onChapterHover, onChapterDetailOpen, onChapterDetailClose, onChapterParagraphOpen, onMentionHover, onEntryOpen, onMentionLeave, onChange, onCreate, onDelete, onDiscard, onSave }) {
  const categoryMeta = codexCategories.find((item) => item.id === category) ?? codexCategories[0];
  const entryChapterMentions = useMemo(() => getEntryChapterMentions(entry, novel), [entry, novel]);
  const entryMentionedEntries = useMemo(() => getCodexEntryMentionEntries(entry, mentionIndex), [entry, mentionIndex]);
  const editorPanelRef = useRef(null);
  const chapterMentionAnchorRef = useRef(null);
  const [chapterMentionMaxHeight, setChapterMentionMaxHeight] = useState(null);

  useLayoutEffect(() => {
    if (!chapterMentionDetail || !editorPanelRef.current || !chapterMentionAnchorRef.current) return;

    const updateMaxHeight = () => {
      const editorRect = editorPanelRef.current.getBoundingClientRect();
      const anchorRect = chapterMentionAnchorRef.current.getBoundingClientRect();
      setChapterMentionMaxHeight(Math.max(120, Math.floor(editorRect.bottom - anchorRect.top)));
    };

    updateMaxHeight();
    const observer = new ResizeObserver(updateMaxHeight);
    observer.observe(editorPanelRef.current);
    observer.observe(chapterMentionAnchorRef.current);
    window.addEventListener('resize', updateMaxHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateMaxHeight);
    };
  }, [chapterMentionDetail, entry?.id]);

  if (!entry) {
    return (
      <section className="codexBlank">
        <div className={`codexBlankIcon entryType${capitalize(categoryMeta.type)}`}>
          <CodexTypeIcon type={categoryMeta.type} />
        </div>
        <p className="eyebrow">{categoryMeta.label}</p>
        <h1>No {categoryMeta.label.toLowerCase()} entries yet</h1>
        <p>Create a {categoryMeta.type} entry to start building this codex category.</p>
        <button className="button primary" onClick={onCreate} type="button">
          Create {categoryMeta.type} entry
        </button>
      </section>
    );
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

      <article className="chapterPanel" ref={editorPanelRef}>
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
            <span className="flagRowCaption">AI Context</span>
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
            <button aria-label="Delete entry" className="button secondary dangerText iconButton" onClick={onDelete} type="button">
              <Trash2 size={14} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
          <CodexMentionedSection
            entries={entryMentionedEntries}
            onOpen={onEntryOpen}
            onHover={() => {}}
            onLeave={() => {}}
          />
          <div className="chapterMentionAnchor" ref={chapterMentionAnchorRef}>
            <ChapterMentionedSection
              chapters={entryChapterMentions}
              onHover={(chapter, rect) => { onChapterHover(chapter, rect); }}
              onLeave={onMentionLeave}
              onOpen={onChapterDetailOpen}
            />
            {chapterMentionDetail && (
              <ChapterMentionDetail
                key={chapterMentionDetail.chapterId ?? chapterMentionDetail.chapterNumber}
                data={chapterMentionDetail}
                maxHeight={chapterMentionMaxHeight}
                onClose={onChapterDetailClose}
                onParagraphOpen={onChapterParagraphOpen}
              />
            )}
          </div>
        </div>

        <CodexBodyEditor body={entry.body} entryId={entry.id} mentionIndex={mentionIndex} onChange={(body) => onChange({ body })} onMentionHover={onMentionHover} onMentionLeave={onMentionLeave} />
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

function CodexBodyEditor({ body, entryId, mentionIndex, onChange, onMentionHover, onMentionLeave }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History, CodexMentionExtension.configure({ mentionIndex })],
    content: markdownToDoc(body),
    editorProps: {
      attributes: {
        class: 'tiptapEditor codexBodyEditor'
      },
      handleDOMEvents: {
        mouseover(view, event) {
          const target = event.target.closest?.('.codexMention');
          if (!target) { if (onMentionLeave) onMentionLeave(); return false; }
          const key = target.getAttribute('data-codex-key');
          if (key && onMentionHover) onMentionHover(key, target.getBoundingClientRect());
          return false;
        },
        mouseout(view, event) {
          const to = event.relatedTarget;
          if (to && (to.closest?.('.codexMention') || to.classList?.contains?.('codexMention'))) return false;
          if (onMentionLeave) onMentionLeave();
          return false;
        }
      }
    },
    onUpdate({ editor }) {
      onChange(docToMarkdown(editor.getJSON()));
    }
  }, [mentionIndex]);

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

function SceneEditor({ scene, sceneIndex, mentionIndex, onChange, onDelete, onMentionHover, onMentionLeave }) {
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
    <section className="sceneCard" data-scene-id={scene.id} data-scene-index={sceneIndex}>
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
          <button aria-label="Delete scene" className="button secondary dangerText iconButton" onClick={onDelete} type="button">
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
        {mention.matches.map((match) => {
          if (match.chapter) {
            return (
              <section className="codexHoverEntry" key={`ch${match.chapter.chapterNumber}`}>
                <div className="codexHoverEntryHeader">
                  <div>
                    <h3>Chapter {match.chapter.chapterNumber}</h3>
                    <p className="entryType entryTypeChapter">chapter</p>
                  </div>
                </div>
                <div className="metadataStack">
                  <span><strong>Title:</strong> {match.chapter.title}</span>
                </div>
              </section>
            );
          }
          return (
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
        );
      })}
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

function ChapterMentionedSection({ chapters, onHover, onLeave, onOpen }) {
  return (
    <section className="chapterCodexMentions">
      <div className="chapterCodexHeader">
        <h2>Chapters Mentioned</h2>
        <span>{chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'}</span>
      </div>
      {chapters.length ? (
        <div className="chapterMentionChips">
          {chapters.map((chapter) => (
            <button
              className="chapterMentionChip chapterMentionChipChapter"
              key={chapter.chapterNumber}
              onClick={() => onOpen?.(chapter)}
              onMouseEnter={(event) => onHover(chapter, event.currentTarget.getBoundingClientRect())}
              onMouseLeave={onLeave}
              type="button"
            >
              <span>Chapter {chapter.chapterNumber}</span>
              <span className="chapterMentionSubtitle">{chapter.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <p>No chapters mention this entry.</p>
      )}
    </section>
  );
}

function ChapterMentionDetail({ data, maxHeight, onClose, onParagraphOpen }) {
  if (!data) return null;
  return (
    <aside
      className="chapterMentionDetail"
      style={maxHeight ? { '--chapter-mention-max-height': `${maxHeight}px` } : undefined}
    >
      <div className="chapterMentionDetailHeader">
        <h2>Chapter {data.chapterNumber}</h2>
        <span className="chapterMentionDetailTitle">{data.title}</span>
        <button className="button secondary iconButton" onClick={onClose} type="button" aria-label="Close">×</button>
      </div>
      <div className="chapterMentionDetailBody">
        {data.paragraphs.length ? data.paragraphs.map((para, index) => (
          <div key={`${para.sceneId ?? para.sceneIndex}:${para.paragraphIndex}`}>
            {index > 0 && <hr className="mentionDivider" />}
            <button
              className="mentionParagraphRow"
              onClick={() => onParagraphOpen({
                chapterId: data.chapterId,
                chapterNumber: data.chapterNumber,
                sceneId: para.sceneId,
                sceneIndex: para.sceneIndex,
                paragraphIndex: para.paragraphIndex
              })}
              type="button"
              aria-label="Go to surrounding"
            >
              <span className="mentionParagraph">
                <HighlightText text={para.text} highlights={para.matches} />
              </span>
              <span className="mentionParagraphChevron">
                <ChevronRight size={16} strokeWidth={2.2} aria-hidden="true" />
                <span className="mentionParagraphTooltip" role="tooltip">Go to surrounding</span>
              </span>
            </button>
          </div>
        )) : <p className="mentionParagraph">No matching paragraphs found.</p>}
      </div>
    </aside>
  );
}

function HighlightText({ text, highlights }) {
  if (!highlights?.length) return text;
  const parts = [];
  let last = 0;
  const sorted = [...highlights].sort((a, b) => a.from - b.from);
  for (const h of sorted) {
    if (h.from > last) parts.push(text.slice(last, h.from));
    parts.push(<mark key={h.from} className="mentionHighlight">{text.slice(h.from, h.to)}</mark>);
    last = h.to;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function WelcomeEmptyState({ onCreate, onOpen, onRestore, status, supported }) {
  if (!supported) {
    return (
      <main className="welcomeShell">
        <section className="welcomeCard">
          <p className="eyebrow">Novel Reader Editor</p>
          <h1>Chromium browser required</h1>
          <p>
            This editor saves markdown directly to a local folder using the browser File System Access API. That workflow is currently supported in Chromium browsers only.
          </p>
          <p>Use Chrome, Edge, Brave, or another Chromium-based browser to open or create a datasource.</p>
          <div className="welcomeActions">
            <span>{status}</span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="welcomeShell">
      <section className="welcomeCard">
        <p className="eyebrow">Novel Reader Editor</p>
        <h1>Use a local datasource folder</h1>
        <p>
          Open an existing local folder or create a new one. Manuscript and codex markdown files stay on your computer and are not uploaded to a server.
        </p>
        <div className="welcomeActions">
          {onRestore && (
            <button className="button secondary" disabled={!supported} onClick={onRestore} type="button">
              Restore recent datasource
            </button>
          )}
          {onOpen && (
            <button className="button secondary" disabled={!supported} onClick={onOpen} type="button">
              Open local datasource
            </button>
          )}
          <button className="button primary" disabled={!supported} onClick={onCreate} type="button">
            Create new Novel
          </button>
          <span>{status}</span>
        </div>
      </section>
    </main>
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

function getEntryChapterMentionParagraphs(entry, chapter) {
  if (!entry || !chapter?.scenes?.length) return [];
  const terms = [entry.name, ...(entry.aliases ?? [])].filter(Boolean).map((t) => String(t).trim()).filter((t) => t);
  if (!terms.length) return [];
  const index = terms.map((term) => ({
    key: stableMentionKey(term), term,
    matches: []
  })).sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
  const result = [];
  for (const [sceneIndex, scene] of chapter.scenes.entries()) {
    for (const [paragraphIndex, raw] of (scene.paragraphs ?? []).entries()) {
      const text = raw || '';
      const matches = [];
      let occupiedRanges = [];
      for (const mention of index) {
        let from = 0;
        while (true) {
          const pos = text.indexOf(mention.term, from);
          if (pos === -1) break;
          const to = pos + mention.term.length;
          const overlaps = occupiedRanges.some(([oFrom, oTo]) => pos < oTo && to > oFrom);
          if (!overlaps && hasMentionBoundary(text, pos, to)) {
            matches.push({ from: pos, to });
            occupiedRanges.push([pos, to]);
          }
          from = pos + 1;
        }
      }
      if (matches.length) result.push({ text, matches, sceneId: scene.id, sceneIndex, paragraphIndex });
    }
  }
  return result;
}

function getEntryChapterMentions(entry, novel) {
  if (!entry || !novel?.chapters?.length) return [];
  const terms = [entry.name, ...(entry.aliases ?? [])].filter(Boolean).map((t) => String(t).trim()).filter((t) => t);
  if (!terms.length) return [];
  const index = terms.map((term) => ({
    key: stableMentionKey(term), term,
    matches: [{ matchType: 'name', matchedAlias: term === entry.name ? null : term, entry, isEntryTerm: true }]
  })).sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
  const byKey = new Map();
  for (const chapter of novel.chapters) {
    for (const scene of chapter.scenes ?? []) {
      const text = (scene.paragraphs ?? []).join('\n\n');
      for (const match of findMentionMatches(text, index)) {
        byKey.set(chapter.chapterNumber, chapter);
        break;
      }
      if (byKey.has(chapter.chapterNumber)) break;
    }
  }
  return [...byKey.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function getCodexEntryMentionEntries(entry, mentionIndex) {
  if (!entry || !mentionIndex?.length) return [];
  const byKey = new Map();
  const text = entry.body || '';
  for (const match of findMentionMatches(text, mentionIndex)) {
    for (const item of match.mention.matches) {
      byKey.set(`${item.entry.category}:${item.entry.id}`, item.entry);
    }
  }
  return [...byKey.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
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

function readUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
  } catch {
    localStorage.removeItem(UI_STATE_KEY);
    return {};
  }
}

function writeUiState(state) {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save UI state', error);
  }
}

function novelDraftKey(volumeId) {
  return `${DRAFT_PREFIX}${volumeId}`;
}

function convertActIdToVolumeId(id) {
  const match = String(id ?? '').match(/^act(\d+)$/);
  return match ? `volume${match[1]}` : id;
}

function readLocalDraft(key = novelDraftKey('volume1')) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function writeLocalDraft(keyOrDraft, maybeDraft) {
  const key = maybeDraft ? keyOrDraft : novelDraftKey('volume1');
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

createRoot(document.getElementById('root')).render(<RootShell />);
