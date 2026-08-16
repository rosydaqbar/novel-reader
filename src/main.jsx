import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import History from '@tiptap/extension-history';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Book, BookOpenText, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, MapPin, Trash2, UserRound } from 'lucide-react';
import {
  hasHandlePermission,
  loadRecentProjectHandle,
  openDatasourceFolder,
  saveRecentProjectHandle,
  supportsLocalFiles,
  verifyHandlePermission
} from './localDatasource.js';
import {
  createProjectFile,
  exportVolumeMarkdown,
  importMarkdownDatasource,
  loadProjectFile,
  openProjectFile,
  saveProjectFile,
  supportsProjectFiles
} from './browserDb.js';
import { composeSystemPrompt } from './assistant/writingRules.browser.js';
import { assembleContext, detectIntent } from './assistant/context.js';
import { runGuard } from './assistant/guard.browser.js';
import { createLLMClient } from './assistant/llmClient.js';
import { createToolRegistry } from './assistant/tools.js';
import { runAgent } from './assistant/agentLoop.js';
import { findMentionOccurrences } from './storage/mentionIndexer.js';
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
  const [aiMessages, setAiMessages] = useState([]);

  return (
    <>
      <InterfaceBackground />
      <App aiMessages={aiMessages} setAiMessages={setAiMessages} />
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

function App({ aiMessages, setAiMessages }) {
  const savedUiState = useMemo(() => readUiState(), []);
  const [activeMenu, setActiveMenu] = useState(savedUiState.activeMenu === 'codex' ? 'codex' : 'novel');
  const [projectFile, setProjectFile] = useState(null);
  const projectFileRef = useRef(null);
  const [projectMeta, setProjectMeta] = useState(null);
  const [projectRevision, setProjectRevision] = useState(0);
  const [projectPersistenceDirty, setProjectPersistenceDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const activationRequestRef = useRef(0);
  const novelRevisionRef = useRef(0);
  const codexRevisionRef = useRef(0);
  const persistenceRevisionRef = useRef(0);
  const saveInProgressRef = useRef(false);
  const [recentProjectHandle, setRecentProjectHandle] = useState(null);
  const [volumes, setVolumes] = useState([]);
  const [volumesLoaded, setVolumesLoaded] = useState(false);
  const [selectedVolumeId, setSelectedVolumeId] = useState(savedUiState.selectedVolumeId ?? convertActIdToVolumeId(savedUiState.selectedActId) ?? 'volume1');
  const [novel, setNovel] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(savedUiState.selectedChapter ?? 0);
  const [status, setStatus] = useState(supportsProjectFiles() ? 'Open or create a Novel project' : 'This app currently supports Chromium browsers only.');
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
  const [projectSearch, setProjectSearch] = useState('');
  const deferredProjectSearch = useDeferredValue(projectSearch);
  const [pendingSearchTarget, setPendingSearchTarget] = useState(null);
  const [hoveredMention, setHoveredMention] = useState(null);
  const [chapterMentionDetail, setChapterMentionDetail] = useState(null);
  const [pendingParagraphAnchor, setPendingParagraphAnchor] = useState(null);
  const sceneEditorsRef = useRef(new Map());
  const sceneEditorSelectionListenersRef = useRef(new Map());
  const sceneEditorBlurListenersRef = useRef(new Map());
  const aiAbortControllerRef = useRef(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiWriterOpen, setAiWriterOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiManualRefs, setAiManualRefs] = useState({ chapters: [], codexEntries: [], selections: [] });
  const [aiAssistAnchor, setAiAssistAnchor] = useState(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [draftBuffer, setDraftBuffer] = useState({ sceneId: null, prose: '' });
  const [aiDraft, setAiDraft] = useState(null);
  const novelRef = useRef(novel);
  novelRef.current = novel;
  const selectedCodexRef = useRef(null);
  const unsavedStateRef = useRef(null);
  unsavedStateRef.current = { codexDirty, dirty, isSaving, projectPersistenceDirty };

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
    if (!supportsProjectFiles()) return;
    let cancelled = false;
    const requestId = ++activationRequestRef.current;

    loadRecentProjectHandle()
      .then(async (handle) => {
        if (!handle || cancelled || requestId !== activationRequestRef.current) return;
        setRecentProjectHandle(handle);
        if (!(await hasHandlePermission(handle))) {
          setStatus('Recent project needs permission. Click Restore recent project to continue.');
          return;
        }
        const project = await loadProjectFile(handle, { requestPermission: false });
        if (cancelled || requestId !== activationRequestRef.current) {
          project.close();
          return;
        }
        await activateProject(project, 'Restored recent project', requestId);
      })
      .catch((error) => setStatus(`Could not restore recent project: ${error.message}`));

    return () => {
      cancelled = true;
      if (activationRequestRef.current === requestId) activationRequestRef.current += 1;
    };
  }, []);

  useEffect(() => () => {
    try {
      projectFileRef.current?.close();
    } catch {}
  }, []);

  useEffect(() => {
    if (!dirty && !codexDirty && !projectPersistenceDirty) return undefined;
    const preventUnsavedClose = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnsavedClose);
    return () => window.removeEventListener('beforeunload', preventUnsavedClose);
  }, [dirty, codexDirty, projectPersistenceDirty]);

  useEffect(() => {
    writeUiState({ activeMenu, selectedVolumeId, selectedChapter, codexCategory, selectedCodexId });
  }, [activeMenu, selectedVolumeId, selectedChapter, codexCategory, selectedCodexId]);

  const refreshAiStatus = async () => {
    try {
      const response = await fetch('/api/ai/status');
      if (!response.ok) throw new Error('AI status is unavailable.');
      setAiStatus(await response.json());
    } catch (error) {
      setAiStatus({ configured: false, error: error.message });
    }
  };

  useEffect(() => {
    refreshAiStatus();
  }, []);

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

  const loadVolumes = (project = projectFileRef.current) => {
    if (!project) return;
    try {
      const nextVolumes = project.projectDb.listVolumes();
      setVolumes(nextVolumes);
      setVolumesLoaded(true);
      if (nextVolumes.length && !nextVolumes.some((volume) => volume.id === selectedVolumeId)) setSelectedVolumeId(nextVolumes[0].id);
      if (!nextVolumes.length) {
        setNovel(null);
        setDirty(false);
        setStatus('This project has no volumes');
      }
    } catch (error) {
      setVolumesLoaded(true);
      setStatus(`Failed to load volumes: ${error.message}`);
    }
  };

  const loadNovel = (nextStatus, useLocalDraft = true, volumeId = selectedVolumeId, project = projectFileRef.current) => {
    if (!project) return;
    const volume = project.projectDb.getVolume(volumeId);
    if (!volume) return;
    setStatus(`Loading ${volume.filename}...`);
    try {
      const nextNovel = project.projectDb.getNovel(volumeId);
      const projectId = project.projectDb.getProjectMeta().projectUuid;
      const draft = useLocalDraft ? readLocalDraft(novelDraftKey(volumeId, projectId)) : null;
      if (draft?.novel) {
        novelRevisionRef.current += 1;
        setNovel(draft.novel);
        setSelectedChapter(Math.min(draft.selectedChapter ?? 0, Math.max(draft.novel.chapters.length - 1, 0)));
        setDirty(true);
        setStatus(`Loaded local draft from ${formatDateTime(draft.savedAt)}`);
        return;
      }

      novelRevisionRef.current += 1;
      setNovel(nextNovel);
      setSelectedChapter((current) => Math.min(current, Math.max(nextNovel.chapters.length - 1, 0)));
      setDirty(false);
      setStatus(nextStatus ?? `Loaded ${volume.filename}`);
    } catch (error) {
      setStatus(`Failed to load: ${error.message}`);
    }
  };

  useEffect(() => {
    if (!projectFile || !volumesLoaded || !volumes.length) return;
    loadNovel(undefined, true, selectedVolumeId, projectFile);
  }, [projectFile, volumesLoaded, volumes.length, selectedVolumeId]);

  useEffect(() => {
    if (!novel || !dirty || !projectMeta) return;
    writeLocalDraft(novelDraftKey(selectedVolumeId, projectMeta.projectUuid), { novel, selectedChapter, savedAt: new Date().toISOString() });
    setStatus('Draft saved in this browser');
  }, [novel, selectedChapter, dirty, selectedVolumeId, projectMeta]);

  const selected = novel?.chapters[selectedChapter];
  const selectedVolume = volumes.find((volume) => volume.id === selectedVolumeId) ?? { id: selectedVolumeId, label: `Volume ${selectedVolumeId.replace('volume', '')}`, filename: `${selectedVolumeId}.md` };
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
  const projectSearchResults = useMemo(() => {
    const query = deferredProjectSearch.trim();
    if (!query || !projectFile) return null;
    try {
      return {
        scenes: projectFile.projectDb.searchScenes(query),
        codex: projectFile.projectDb.searchCodex(query)
      };
    } catch (error) {
      console.error('Project search failed', error);
      return { scenes: [], codex: [] };
    }
  }, [deferredProjectSearch, projectFile, projectRevision]);

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
    if (!codexEntry || !codexDirty || !projectMeta) return;
    writeLocalDraft(codexDraftKey(codexEntry, projectMeta.projectUuid), { entry: codexEntry, savedAt: new Date().toISOString() });
    setCodexStatus('Draft saved in this browser');
  }, [codexEntry, codexDirty, projectMeta]);

  useEffect(() => {
    if (!pendingSearchTarget || !novel || selectedVolumeId !== pendingSearchTarget.volumeId) return;
    const chapterIndex = novel.chapters.findIndex((chapter) => chapter.id === pendingSearchTarget.chapterId);
    if (chapterIndex < 0) return;
    setSelectedChapter(chapterIndex);
    setPendingParagraphAnchor({ sceneId: pendingSearchTarget.sceneId, paragraphIndex: 0 });
    setPendingSearchTarget(null);
  }, [novel, pendingSearchTarget, selectedVolumeId]);

  const loadCodex = () => {
    if (!projectFileRef.current) return;
    try {
      setCodex(projectFileRef.current.projectDb.listCodex());
      setCodexStatus('Loaded codex');
    } catch (error) {
      setCodexStatus(`Failed to load codex: ${error.message}`);
    }
  };

  const loadCodexEntry = (category, id, useLocalDraft = true) => {
    if (!projectFileRef.current) return Promise.resolve();
    setCodexStatus('Loading entry...');
    try {
      const entry = projectFileRef.current.projectDb.getCodexEntry(category, id);
      if (!entry) throw new Error('Codex entry was not found.');
      const projectId = projectFileRef.current.projectDb.getProjectMeta().projectUuid;
      const draft = useLocalDraft ? readLocalDraft(codexDraftKey(entry, projectId)) : null;
      if (draft?.entry) {
        codexRevisionRef.current += 1;
        setCodexEntry(draft.entry);
        setCodexDirty(true);
        setCodexStatus(`Loaded local draft from ${formatDateTime(draft.savedAt)}`);
        return Promise.resolve();
      }

      codexRevisionRef.current += 1;
      setCodexEntry(entry);
      setCodexDirty(false);
      setCodexStatus('Loaded entry');
      return Promise.resolve();
    } catch (error) {
      setCodexStatus(`Failed to load entry: ${error.message}`);
      return Promise.resolve();
    }
  };

  const markProjectMutated = () => {
    persistenceRevisionRef.current += 1;
    setProjectPersistenceDirty(true);
  };

  const updateCodexEntry = (patch) => {
    codexRevisionRef.current += 1;
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

  const saveProject = async () => {
    if (!projectFile || saveInProgressRef.current) return;
    saveInProgressRef.current = true;
    setIsSaving(true);
    setStatus(`Saving ${projectFile.fileName || 'project.novel'}...`);
    setCodexStatus('Saving project...');
    const savingProject = projectFile;
    const savingVolumeId = selectedVolumeId;
    const savingCodexKey = codexEntry ? `${codexEntry.category}:${codexEntry.id}` : null;
    const novelRevision = novelRevisionRef.current;
    const codexRevision = codexRevisionRef.current;
    const saveNovelDraft = dirty && Boolean(novel);
    const saveCodexDraft = codexDirty && Boolean(codexEntry);
    try {
      const db = savingProject.projectDb;
      if (saveNovelDraft) {
        db.putNovel(savingVolumeId, novel);
        markProjectMutated();
      }
      if (saveCodexDraft) {
        db.updateCodexEntry(codexEntry.category, codexEntry.id, codexEntry);
        markProjectMutated();
      }
      const persistenceRevision = persistenceRevisionRef.current;
      await saveProjectFile(savingProject);
      await saveRecentProjectHandle(savingProject.fileHandle);
      setRecentProjectHandle(savingProject.fileHandle);
      if (persistenceRevisionRef.current === persistenceRevision) setProjectPersistenceDirty(false);

      if (
        saveNovelDraft
        && projectFileRef.current === savingProject
        && selectedVolumeId === savingVolumeId
        && novelRevisionRef.current === novelRevision
      ) {
        localStorage.removeItem(novelDraftKey(savingVolumeId, projectMeta?.projectUuid));
        setNovel(db.getNovel(savingVolumeId));
        setDirty(false);
      }
      if (
        saveCodexDraft
        && projectFileRef.current === savingProject
        && `${codexEntry?.category}:${codexEntry?.id}` === savingCodexKey
        && codexRevisionRef.current === codexRevision
      ) {
        localStorage.removeItem(codexDraftKey(codexEntry, projectMeta?.projectUuid));
        const entry = db.getCodexEntry(codexEntry.category, codexEntry.id);
        setCodex(db.listCodex());
        setCodexEntry(entry);
        setCodexDirty(false);
      }

      setProjectMeta(db.getProjectMeta());
      setProjectRevision((current) => current + 1);
      const newerDraftRemains = novelRevisionRef.current !== novelRevision || codexRevisionRef.current !== codexRevision;
      const savedStatus = newerDraftRemains
        ? 'Saved earlier changes; a newer browser draft remains'
        : `Saved ${savingProject.fileName || 'project.novel'}`;
      setStatus(savedStatus);
      setCodexStatus(savedStatus);
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
      setCodexStatus(`Save failed: ${error.message}`);
      setProjectPersistenceDirty(true);
    } finally {
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
  };

  const saveCodexEntry = async () => {
    await saveProject();
  };

  const discardCodexChanges = () => {
    if (!codexDirty || !codexEntry) return;
    if (!window.confirm('Discard the local codex draft and reload this entry from the project database?')) return;
    localStorage.removeItem(codexDraftKey(codexEntry, projectMeta?.projectUuid));
    loadCodexEntry(codexEntry.category, codexEntry.id, false);
  };

  const addCodexEntry = async () => {
    const name = window.prompt('New codex entry name:', 'New Entry');
    if (!name) return;
    setCodexStatus('Creating codex entry...');
    try {
      const entry = projectFile.projectDb.createCodexEntry({ category: codexCategory, name });
      codexRevisionRef.current += 1;
      markProjectMutated();
      const persistenceRevision = persistenceRevisionRef.current;
      setCodex(projectFile.projectDb.listCodex());
      setSelectedCodexId(entry.id);
      setCodexEntry(entry);
      setCodexDirty(false);
      setProjectRevision((current) => current + 1);
      await saveProjectFile(projectFile);
      if (persistenceRevisionRef.current === persistenceRevision) setProjectPersistenceDirty(false);
      setCodexStatus(`Created ${entry.name}`);
    } catch (error) {
      setProjectPersistenceDirty(true);
      setCodexStatus(`Create failed: ${error.message}`);
    }
  };

  const deleteCodexEntry = async () => {
    if (!codexEntry) return;
    if (!window.confirm(`Delete ${codexEntry.name} from this project?`)) return;
    setCodexStatus('Deleting codex entry...');
    try {
      projectFile.projectDb.deleteCodexEntry(codexEntry.category, codexEntry.id);
      codexRevisionRef.current += 1;
      markProjectMutated();
      const persistenceRevision = persistenceRevisionRef.current;
      setCodex(projectFile.projectDb.listCodex());
      setSelectedCodexId(null);
      setCodexEntry(null);
      setCodexDirty(false);
      setProjectRevision((current) => current + 1);
      await saveProjectFile(projectFile);
      if (persistenceRevisionRef.current === persistenceRevision) setProjectPersistenceDirty(false);
      localStorage.removeItem(codexDraftKey(codexEntry, projectMeta?.projectUuid));
      setCodexStatus('Deleted codex entry');
    } catch (error) {
      setProjectPersistenceDirty(true);
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

  const activateProject = async (project, nextStatus = 'Loaded project', requestId = ++activationRequestRef.current) => {
    if (requestId !== activationRequestRef.current) {
      project.close();
      return false;
    }
    try {
      const db = project.projectDb;
      const nextVolumes = db.listVolumes();
      const nextVolumeId = nextVolumes.some((volume) => volume.id === selectedVolumeId) ? selectedVolumeId : nextVolumes[0]?.id;
      if (projectFileRef.current && projectFileRef.current !== project) projectFileRef.current.close();
      projectFileRef.current = project;
      setProjectFile(project);
      setProjectMeta(db.getProjectMeta());
      setRecentProjectHandle(project.fileHandle);
      setNovel(null);
      setDirty(false);
      setSelectedChapter(0);
      setCodex(db.listCodex());
      setCodexEntry(null);
      setCodexDirty(false);
      setCodexStatus('Loaded codex');
      setVolumes(nextVolumes);
      setVolumesLoaded(true);
      setProjectPersistenceDirty(false);
      persistenceRevisionRef.current = 0;
      novelRevisionRef.current += 1;
      codexRevisionRef.current += 1;
      setProjectRevision((current) => current + 1);
      saveRecentProjectHandle(project.fileHandle).catch((error) => {
        console.error('Failed to remember recent project handle', error);
      });

      if (nextVolumeId) {
        setSelectedVolumeId(nextVolumeId);
        setStatus(`${nextStatus}: ${project.fileName || 'project.novel'}`);
      } else {
        setStatus('This project has no volumes');
      }
      return true;
    } catch (error) {
      if (projectFileRef.current !== project && !project.closed) project.close();
      throw error;
    }
  };

  const canSwitchProject = () => {
    const unsaved = unsavedStateRef.current;
    if (unsaved.isSaving || projectFileRef.current?.saving) {
      setStatus('Wait for the current project save to finish.');
      return false;
    }
    if (!unsaved.dirty && !unsaved.codexDirty && !unsaved.projectPersistenceDirty) return true;
    return window.confirm('Open another project and leave the current unsaved changes behind?');
  };

  const openProject = async () => {
    if (!canSwitchProject()) return;
    const requestId = ++activationRequestRef.current;
    setStatus('Opening project...');
    try {
      await activateProject(await openProjectFile(), 'Loaded project', requestId);
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(`Open failed: ${error.message}`);
    }
  };

  const restoreRecentProject = async () => {
    if (!recentProjectHandle || !canSwitchProject()) return;
    const requestId = ++activationRequestRef.current;
    setStatus('Restoring recent project...');
    try {
      if (!(await verifyHandlePermission(recentProjectHandle))) {
        setStatus('Project file permission was not granted.');
        return;
      }
      const project = await loadProjectFile(recentProjectHandle, { requestPermission: false });
      await activateProject(project, 'Restored recent project', requestId);
    } catch (error) {
      setStatus(`Restore failed: ${error.message}`);
    }
  };

  const createProject = async () => {
    if (!canSwitchProject()) return;
    const title = window.prompt('Project name:', 'Untitled Novel')?.trim();
    if (!title) return;
    const requestId = ++activationRequestRef.current;
    setStatus('Creating project...');
    try {
      const project = await createProjectFile({ title });
      const volume = project.projectDb.createVolume({ number: 1, title });
      project.projectDb.putNovel(volume.id, starterNovel(volume.label, title));
      await project.save();
      await activateProject(project, 'Created project', requestId);
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(`Create failed: ${error.message}`);
    }
  };

  const importMarkdownProject = async () => {
    if (!canSwitchProject()) return;
    const startingProject = projectFileRef.current;
    const startingNovelRevision = novelRevisionRef.current;
    const startingCodexRevision = codexRevisionRef.current;
    const startingPersistenceRevision = persistenceRevisionRef.current;
    const requestId = ++activationRequestRef.current;
    setStatus('Choose the legacy markdown datasource folder...');
    let importedProject;
    try {
      const sourceHandle = await openDatasourceFolder('read');
      const result = await importMarkdownDatasource(sourceHandle, {
        onProgress(progress) {
          setStatus(`Importing ${progress.label} (${progress.current}/${progress.total})...`);
        }
      });
      importedProject = result.project;
      const sourceChangedDuringImport = projectFileRef.current !== startingProject
        || novelRevisionRef.current !== startingNovelRevision
        || codexRevisionRef.current !== startingCodexRevision
        || persistenceRevisionRef.current !== startingPersistenceRevision;
      if (sourceChangedDuringImport && !canSwitchProject()) {
        importedProject.close();
        return;
      }
      const activated = await activateProject(result.project, 'Imported markdown datasource', requestId);
      if (!activated) return;
      importedProject = null;
      markProjectMutated();
      setStatus(
        `Imported ${result.volumeCount} volume${result.volumeCount === 1 ? '' : 's'} and ${result.codexCount} codex entr${result.codexCount === 1 ? 'y' : 'ies'}. Click Save project to create the .novel file.`
      );
    } catch (error) {
      if (importedProject && projectFileRef.current !== importedProject && !importedProject.closed) importedProject.close();
      if (error.name !== 'AbortError') setStatus(`Import failed: ${error.message}`);
    }
  };

  const openCodexEntry = (entry) => {
    setActiveMenu('codex');
    changeCodexCategory(entry.category);
    setSelectedCodexId(entry.id);
  };

  const openSceneSearchResult = (result) => {
    setProjectSearch('');
    setActiveMenu('novel');
    setPendingSearchTarget(result);
    if (result.volumeId === selectedVolumeId && novel) {
      const chapterIndex = novel.chapters.findIndex((chapter) => chapter.id === result.chapterId);
      if (chapterIndex >= 0) {
        setSelectedChapter(chapterIndex);
        setPendingParagraphAnchor({ sceneId: result.sceneId, paragraphIndex: 0 });
        setPendingSearchTarget(null);
      }
      return;
    }
    setSelectedChapter(0);
    setSelectedVolumeId(result.volumeId);
  };

  const openCodexSearchResult = (result) => {
    setProjectSearch('');
    setActiveMenu('codex');
    changeCodexCategory(result.category);
    setSelectedCodexId(result.entryId);
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

  const saveNovel = async () => {
    await saveProject();
  };

  const exportMarkdown = async () => {
    setStatus(`Exporting ${selectedVolume.filename}...`);
    try {
      await exportVolumeMarkdown(projectFile, selectedVolumeId, { novel });
      setStatus(`Exported ${selectedVolume.filename}`);
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(`Export failed: ${error.message}`);
    }
  };

  const addVolume = async () => {
    setStatus('Creating volume...');
    try {
      const title = novel?.title || projectMeta?.title || 'Untitled Novel';
      const volume = projectFile.projectDb.createVolume({ title });
      projectFile.projectDb.putNovel(volume.id, starterNovel(volume.label, title));
      novelRevisionRef.current += 1;
      markProjectMutated();
      const persistenceRevision = persistenceRevisionRef.current;
      const nextVolumes = projectFile.projectDb.listVolumes();
      setVolumes(nextVolumes);
      setSelectedVolumeId(volume.id);
      setNovel(projectFile.projectDb.getNovel(volume.id));
      setSelectedChapter(0);
      setDirty(false);
      setProjectRevision((current) => current + 1);
      await saveProjectFile(projectFile);
      if (persistenceRevisionRef.current === persistenceRevision) setProjectPersistenceDirty(false);
      setStatus(`Created ${volume.filename} in ${projectFile.fileName}`);
    } catch (error) {
      setProjectPersistenceDirty(true);
      setStatus(`Create failed: ${error.message}`);
    }
  };

  const deleteVolume = async () => {
    if (!selectedVolume) return;
    if (!window.confirm(`Delete ${selectedVolume.label} from this project?`)) return;

    setStatus(`Deleting ${selectedVolume.label}...`);
    try {
      projectFile.projectDb.deleteVolume(selectedVolume.id);
      novelRevisionRef.current += 1;
      markProjectMutated();
      const persistenceRevision = persistenceRevisionRef.current;
      const nextVolumes = projectFile.projectDb.listVolumes();
      setVolumes(nextVolumes);
      setProjectRevision((current) => current + 1);

      if (!nextVolumes.length) {
        setNovel(null);
        setDirty(false);
        setVolumesLoaded(true);
        await saveProjectFile(projectFile);
        if (persistenceRevisionRef.current === persistenceRevision) setProjectPersistenceDirty(false);
        localStorage.removeItem(novelDraftKey(selectedVolume.id, projectMeta?.projectUuid));
        setStatus(`Deleted ${selectedVolume.label}`);
        return;
      }

      const currentIndex = volumes.findIndex((volume) => volume.id === selectedVolume.id);
      const nextVolume = nextVolumes[Math.max(0, Math.min(currentIndex, nextVolumes.length - 1))];
      setSelectedVolumeId(nextVolume.id);
      setSelectedChapter(0);
      setNovel(projectFile.projectDb.getNovel(nextVolume.id));
      await saveProjectFile(projectFile);
      if (persistenceRevisionRef.current === persistenceRevision) setProjectPersistenceDirty(false);
      localStorage.removeItem(novelDraftKey(selectedVolume.id, projectMeta?.projectUuid));
      setStatus(`Deleted ${selectedVolume.label}`);
    } catch (error) {
      setProjectPersistenceDirty(true);
      setStatus(`Delete failed: ${error.message}`);
    }
  };

  const changeVolume = (volumeId) => {
    if (volumeId === selectedVolumeId) return;
    setSelectedChapter(0);
    setSelectedVolumeId(volumeId);
  };

  const updateChapter = (chapterId, patch) => {
    novelRevisionRef.current += 1;
    setNovel((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => (chapter.id === chapterId ? { ...chapter, ...patch } : chapter))
    }));
    setDirty(true);
  };

  const updateScene = (chapterId, sceneId, patch) => {
    novelRevisionRef.current += 1;
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

  const selectionFromEditor = useCallback((sceneId, editor) => {
    const state = editor?.view?.state ?? editor?.state;
    const selection = state?.selection;
    if (!selection || selection.empty) return null;
    const chapter = novelRef.current?.chapters?.find((candidate) => candidate.scenes?.some((scene) => scene.id === sceneId));
    const excerpt = state.doc.textBetween(selection.from, selection.to, '\n').trim();
    return chapter && excerpt ? { sceneId, chapterId: chapter.id, excerpt, from: selection.from, to: selection.to } : null;
  }, []);

  const registerSceneEditor = useCallback((sceneId, editor) => {
    const registered = sceneEditorsRef.current.get(sceneId);
    const selectionListener = sceneEditorSelectionListenersRef.current.get(sceneId);
    const blurListener = sceneEditorBlurListenersRef.current.get(sceneId);
    if (registered && selectionListener) registered.off('selectionUpdate', selectionListener);
    if (registered && blurListener) registered.off('blur', blurListener);

    if (!editor) {
      sceneEditorsRef.current.delete(sceneId);
      sceneEditorSelectionListenersRef.current.delete(sceneId);
      sceneEditorBlurListenersRef.current.delete(sceneId);
      setAiAssistAnchor((current) => current?.sceneId === sceneId ? null : current);
      return;
    }

    const updateSelection = () => {
      const selection = selectionFromEditor(sceneId, editor);
      if (!selection) {
        setAiAssistAnchor(null);
        return;
      }
      let startCoords;
      let endCoords;
      const endPosition = selection.to < editor.state.doc.content.size ? selection.to : selection.from;
      try {
        startCoords = editor.view?.coordsAtPos?.(selection.from);
      } catch {
        startCoords = null;
      }
      if (endPosition === selection.from) {
        endCoords = startCoords;
      } else {
        try {
          endCoords = editor.view?.coordsAtPos?.(endPosition);
        } catch {
          endCoords = null;
        }
      }
      if (!startCoords) startCoords = endCoords;
      if (!endCoords) endCoords = startCoords;
      if (!startCoords || !endCoords) {
        setAiAssistAnchor(null);
        return;
      }
      const margin = 14;
      const gap = 8;
      const buttonWidth = 148;
      const buttonHeight = 36;
      const right = endCoords.right ?? endCoords.left;
      let x = right + gap;
      let y = startCoords.top - buttonHeight - gap;
      if (y < margin) y = (startCoords.bottom ?? startCoords.top) + gap;
      x = Math.max(margin, Math.min(x, window.innerWidth - buttonWidth - margin));
      y = Math.max(margin, Math.min(y, window.innerHeight - buttonHeight - margin));
      setAiAssistAnchor({ ...selection, x, y });
    };
    const handleBlur = () => setAiAssistAnchor(null);
    sceneEditorsRef.current.set(sceneId, editor);
    sceneEditorSelectionListenersRef.current.set(sceneId, updateSelection);
    sceneEditorBlurListenersRef.current.set(sceneId, handleBlur);
    editor.on('selectionUpdate', updateSelection);
    editor.on('blur', handleBlur);
  }, [selectionFromEditor]);

  const pinAiAssistSelection = () => {
    if (!aiAssistAnchor) return;
    const entries = Object.values(codex ?? {}).flat();
    const entryIdByInternalId = new Map(entries.map((entry) => [entry.internalId, entry.id]));
    const codexIds = [...new Set(
      findMentionOccurrences(aiAssistAnchor.excerpt, entries)
        .map((occurrence) => entryIdByInternalId.get(occurrence.entryInternalId))
        .filter(Boolean)
    )];
    const { x, y, ...selection } = aiAssistAnchor;
    setAiManualRefs((current) => ({ ...current, selections: [...(current.selections ?? []), { ...selection, codexIds }] }));
    setAiAssistAnchor(null);
    setAiWriterOpen(true);
  };

  const runAiWriter = async () => {
    const prompt = aiPrompt.trim();
    const db = projectFileRef.current?.projectDb;
    if (!prompt || !db || aiRunning) return;
    const mode = detectIntent({ prompt, manualRefs: aiManualRefs });
    const entries = Object.values(codex ?? {}).flat();
    const projectFacts = {
      title: projectMeta?.title || novel?.title,
      projectTitle: projectMeta?.title || novel?.title,
      characterNames: entries.filter((entry) => entry.type === 'character').map((entry) => entry.name),
      codexNames: entries.map((entry) => entry.name),
      codexAliases: entries.flatMap((entry) => entry.aliases ?? []),
      chapterTitles: (novel?.chapters ?? []).map((chapter) => chapter.title)
    };
    const codexFlags = Object.fromEntries(entries.map((entry) => [entry.id, {
      doNotTrack: entry.doNotTrack,
      noAutoInclude: entry.noAutoInclude,
      alwaysIncludeInContext: entry.alwaysIncludeInContext
    }]));
    const controller = new AbortController();
    aiAbortControllerRef.current = controller;
    setAiRunning(true);
    setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: prompt }]);
    setAiPrompt('');
    setAiDraft(null);
    const buffer = { sceneId: null, prose: '' };
    setDraftBuffer(buffer);
    try {
      const llmClient = createLLMClient({});
      const guard = await runGuard({ prompt, mode, projectFacts, llmClient, signal: controller.signal });
      if (guard.verdict === 'out_of_topic') {
        setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'guard', content: guard.reason }]);
        return;
      }
      if (guard.skipped) {
        setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'guard', content: 'Guard skipped — continuing with your request.' }]);
      } else {
        setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'guard', content: 'Request cleared for novel writing.' }]);
      }
      if (controller.signal.aborted) return;
      const context = assembleContext({ db, manualRefs: aiManualRefs, codexFlags });
      const result = await runAgent({
        prompt,
        context,
        systemPrompt: composeSystemPrompt(projectFacts),
        tools: createToolRegistry({ db, draftBuffer: buffer }),
        llmClient,
        signal: controller.signal,
        onEvent(type, payload) {
          if (type === 'iteration') {
            setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'status', content: `Iteration ${payload.n}/12` }]);
            return;
          }
          if (type === 'thought') {
            setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'status', content: payload }]);
            return;
          }
          if (type === 'text_delta') {
            setAiMessages((current) => {
              const last = current.at(-1);
              if (last?.role === 'assistant' && last.streaming) {
                return [...current.slice(0, -1), { ...last, content: last.content + payload }];
              }
              return [...current, { id: crypto.randomUUID(), role: 'assistant', content: payload, streaming: true }];
            });
            return;
          }
          if (type === 'tool_started') {
            setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'tool', name: payload.name, content: `Using ${payload.name}…`, state: 'running' }]);
            return;
          }
          if (type === 'tool_completed') {
            setAiMessages((current) => {
              const index = current.findLastIndex((message) => message.role === 'tool' && message.name === payload.name && message.state === 'running');
              return index < 0 ? [...current, { id: crypto.randomUUID(), role: 'tool', name: payload.name, content: `Used ${payload.name}`, state: 'completed' }] : current.map((message, messageIndex) => messageIndex === index ? { ...message, content: `Used ${payload.name}`, state: 'completed' } : message);
            });
            return;
          }
          if (type === 'error') setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'error', content: payload.message }]);
        }
      });
      const prose = result.finalProse || buffer.prose;
      if (prose) {
        const draft = { prose, selection: context.selection, sceneId: buffer.sceneId, stopReason: result.stopReason };
        setAiDraft(draft);
        setAiMessages((current) => [...current.map((message) => message.streaming ? { ...message, streaming: false } : message), { id: crypto.randomUUID(), role: 'draft', content: prose }]);
      }
    } catch (error) {
      if (!controller.signal.aborted) setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'error', content: error.message }]);
    } finally {
      if (aiAbortControllerRef.current === controller) aiAbortControllerRef.current = null;
      setAiRunning(false);
    }
  };

  const insertAiDraft = () => {
    if (!aiDraft?.prose) return;
    const targetSelection = aiDraft.selection;
    const targetSceneId = targetSelection?.sceneId ?? aiDraft.sceneId ?? selected?.scenes?.at(-1)?.id;
    const editor = sceneEditorsRef.current.get(targetSceneId);
    if (!editor) {
      setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'error', content: 'The pinned selection is not open. Navigate to its chapter and scene, then insert again.' }]);
      return;
    }
    const content = paragraphsToDoc(String(aiDraft.prose).split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean));
    if (targetSelection && targetSelection.from != null && targetSelection.to != null) {
      const expectedExcerpt = normalizeWhitespace(targetSelection.excerpt);
      let range = null;
      if (targetSelection.from >= 0 && targetSelection.to <= editor.state.doc.content.size) {
        const currentExcerpt = editor.state.doc.textBetween(targetSelection.from, targetSelection.to, '\n');
        if (normalizeWhitespace(currentExcerpt) === expectedExcerpt) range = { from: targetSelection.from, to: targetSelection.to };
      }
      if (!range) {
        const matchingRanges = findExcerptRange(editor.state.doc, expectedExcerpt);
        if (matchingRanges.length === 1) range = matchingRanges[0];
      }
      if (!range) {
        setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'error', content: 'The pinned selection has changed; re-select and pin it again.' }]);
        return;
      }
      editor.chain().focus().insertContentAt(range, content.content).run();
    } else {
      editor.chain().focus().insertContentAt(editor.state.doc.content.size, content.content).run();
    }
    setAiDraft(null);
  };

  const addScene = (chapterId) => {
    novelRevisionRef.current += 1;
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

    novelRevisionRef.current += 1;
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
    novelRevisionRef.current += 1;
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

    novelRevisionRef.current += 1;
    setNovel((current) => ({
      ...current,
      chapters: current.chapters.filter((item) => item.id !== chapterId)
    }));
    setSelectedChapter((current) => Math.max(0, Math.min(current, novel.chapters.length - 2)));
    setDirty(true);
  };

  const discardChanges = () => {
    if (!dirty) return;
    if (!window.confirm(`Discard the browser draft and reload ${selectedVolume.label} from the project database?`)) return;
    localStorage.removeItem(novelDraftKey(selectedVolumeId, projectMeta?.projectUuid));
    loadNovel('Discarded local draft', false, selectedVolumeId);
  };

  if (!projectFile) {
    return <WelcomeEmptyState onCreate={createProject} onImport={supportsLocalFiles() ? importMarkdownProject : null} onOpen={openProject} onRestore={recentProjectHandle ? restoreRecentProject : null} status={status} supported={supportsProjectFiles()} />;
  }

  if (!novel && volumesLoaded && !volumes.length) {
    return <WelcomeEmptyState onCreate={addVolume} onImport={supportsLocalFiles() ? importMarkdownProject : null} onOpen={openProject} status={status} supported={supportsProjectFiles()} />;
  }

  if (!novel) {
    return <main className="loading">{status}</main>;
  }

  return (
    <>
      <main className={aiWriterOpen ? 'shell hasAiPanel' : 'shell'}>
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
          <span className="eyebrow">{activeMenu === 'codex' ? 'Codex' : 'Novel'}</span>
          <strong>{projectMeta?.title || novel.title || 'Untitled Project'}</strong>
        </div>
        <div className="stats">
          <span>{projectFile.fileName || 'project.novel'}</span>
          <button className="button sidebarAction" onClick={saveProject} type="button">
            Save project
          </button>
          <button className="button sidebarAction" onClick={openProject} type="button">
            Open project
          </button>
          {supportsLocalFiles() && (
            <button className="button sidebarAction" onClick={importMarkdownProject} type="button">
              Import Markdown
            </button>
          )}
        </div>
        <div className="codexFilters">
          <input
            aria-label="Search project"
            onChange={(event) => setProjectSearch(event.target.value)}
            placeholder="Search scenes and codex..."
            value={projectSearch}
          />
          {projectSearch && (
            <button className="button ghost filterClear" onClick={() => setProjectSearch('')} type="button">
              Clear search
            </button>
          )}
        </div>
        {projectSearch.trim() ? (
          <nav className="chapterList" aria-label="Project search results">
            {(projectSearchResults?.scenes ?? []).map((result) => (
              <button className="chapterLink" key={`scene:${result.sceneId}`} onClick={() => openSceneSearchResult(result)} type="button">
                <span className="chapterLinkMeta">
                  <span>Volume {result.volumeNumber}, Chapter {result.chapterNumber}</span>
                  <small>{result.heading}</small>
                </span>
                <strong>{result.snippet || result.chapterTitle}</strong>
              </button>
            ))}
            {(projectSearchResults?.codex ?? []).map((result) => (
              <button className="chapterLink" key={`codex:${result.entryInternalId}`} onClick={() => openCodexSearchResult(result)} type="button">
                <span className="chapterLinkMeta">
                  <span>{result.category}</span>
                  <small>Codex</small>
                </span>
                <strong>{result.name}: {result.snippet}</strong>
              </button>
            ))}
            {projectSearchResults && !projectSearchResults.scenes.length && !projectSearchResults.codex.length && (
              <div className="emptyMenuState"><p>No project results found.</p></div>
            )}
          </nav>
        ) : activeMenu !== 'codex' ? (
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
        {activeMenu !== 'codex' ? (
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
                <button className="button secondary" onClick={exportMarkdown} type="button">
                  Export Markdown
                </button>
                <button className="button secondary dangerText" onClick={deleteVolume} type="button">
                  Remove volume
                </button>
                <button className="button primary" onClick={saveNovel} type="button">
                  Save project
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
                chapterId={selected.id}
                scene={scene}
                sceneIndex={sceneIndex}
                mentionIndex={codexMentionIndex}
                onChange={(patch) => updateScene(selected.id, scene.id, patch)}
                onDelete={() => deleteScene(selected.id, scene.id)}
                onMentionHover={showMentionHover}
                onMentionLeave={hideMentionHover}
                onEditorReady={registerSceneEditor}
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
        {aiSettingsOpen && <AISettingsDialog onClose={() => setAiSettingsOpen(false)} onStatusChange={refreshAiStatus} status={aiStatus} />}
        {hoveredMention && <CodexMentionHoverCard data={hoveredMention} onMouseEnter={keepMentionHover} onMouseLeave={hideMentionHover} />}
      </section>
      <AIWriterPanel
        chapters={novel?.chapters ?? []}
        codexEntries={Object.values(codex ?? {}).flat()}
        draft={aiDraft}
        manualRefs={aiManualRefs}
        onClose={() => setAiWriterOpen(false)}
        onConfigure={() => setAiSettingsOpen(true)}
        onInsert={insertAiDraft}
        onPromptChange={setAiPrompt}
        onRefsChange={setAiManualRefs}
        onRun={runAiWriter}
        onStop={() => aiAbortControllerRef.current?.abort()}
        prompt={aiPrompt}
        running={aiRunning}
        status={aiStatus}
        messages={aiMessages}
      />
      </main>
      <button
        aria-expanded={aiWriterOpen}
        className={aiWriterOpen ? 'aiWriterSticky active' : 'aiWriterSticky'}
        onClick={() => setAiWriterOpen((current) => !current)}
        type="button"
      >
        AI Writer
      </button>
      {aiAssistAnchor && (
        <div className="aiAssistAnchor" style={{ left: aiAssistAnchor.x, top: aiAssistAnchor.y }}>
          <button className="button primary" onMouseDown={(event) => event.preventDefault()} onClick={pinAiAssistSelection} type="button">
            AI Write Assist
          </button>
        </div>
      )}
    </>
  );
}

function AIWriterPanel({ chapters, codexEntries, draft, manualRefs, messages, onClose, onConfigure, onInsert, onPromptChange, onRefsChange, onRun, onStop, prompt, running, status }) {
  const ready = Boolean(status?.configured && status?.authed);
  const mode = detectIntent({ prompt, manualRefs });
  const selections = manualRefs.selections ?? [];
  const codexEntryById = new Map(codexEntries.map((entry) => [String(entry.id), entry]));
  const [detailView, setDetailView] = useState(null);
  const [contextOpen, setContextOpen] = useState(false);
  const contextCount = selections.length + (manualRefs.chapters?.length ?? 0) + (manualRefs.codexEntries?.length ?? 0);
  const detailSelection = detailView?.selection;
  const detailChapter = chapters.find((chapter) => chapter.id === detailSelection?.chapterId);
  const detailScene = detailChapter?.scenes?.find((scene) => scene.id === detailSelection?.sceneId);
  const detailCodexEntries = (detailSelection?.codexIds ?? []).map((id) => codexEntryById.get(String(id)) ?? { id, name: String(id) });
  return (
    <>
    <aside className="aiWriterPanel" aria-label="AI Writer" id="ai-writer-panel">
      <div className="aiWriterPanelContent">
        <header className="panelHeader aiChatHeader">
          <div><p className="eyebrow">AI Writer</p><h2>AI Writer</h2></div>
          <div className="panelActions"><button className="button ghost" onClick={onConfigure} type="button">Settings</button><button className="button ghost" onClick={onClose} type="button">Close</button></div>
        </header>
        <div className="aiChatThread" aria-live="polite">
          {!ready ? <div className="aiChatEmpty"><strong>Configure AI first</strong><span>{status?.error || 'Choose a provider before sending writing requests.'}</span><button className="button primary" onClick={onConfigure} type="button">Configure AI</button></div> : !messages.length ? <div className="aiChatEmpty">Ask for an outline, a scene, or a continuation — then pin chapters or codex entries in the context reference below.</div> : messages.map((message) => (
            <article className={`aiChatMessage ${message.role}`} key={message.id}>
              <p>{message.content}</p>
              {message.role === 'draft' && draft?.prose === message.content && <button className="button primary" onClick={onInsert} type="button">Insert draft</button>}
            </article>
          ))}
        </div>
        <div className="aiChatComposerUnit">
          <section className="aiChatContext" aria-label="Writing context">
            <div className="panelHeader">
              <p className="eyebrow">Context reference{contextCount > 0 ? ` · ${contextCount}` : ''}</p>
              <button aria-controls="aiChatContextCards" aria-expanded={contextOpen} className="button ghost" onClick={() => setContextOpen((current) => !current)} type="button">{contextOpen ? <><ChevronsDown size={14} aria-hidden="true" /> Close</> : <><ChevronsUp size={14} aria-hidden="true" /> Open</>}</button>
            </div>
            <div className={contextOpen ? 'aiChatContextCards contextCardsOpen' : 'aiChatContextCards'} id="aiChatContextCards" inert={!contextOpen}>
              <div className="aiChatContextCardsInner panelStack">
                <AiRefPicker
                  label="Chapters"
                  items={chapters.map((chapter) => ({ id: chapter.id, title: chapter.title }))}
                  value={manualRefs.chapters}
                  onChange={(chapters) => onRefsChange({ ...manualRefs, chapters })}
                />
                <AiRefPicker
                  label="Codex entries"
                  items={codexEntries.map((entry) => ({ id: entry.id, title: entry.name }))}
                  value={manualRefs.codexEntries}
                  onChange={(codexEntries) => onRefsChange({ ...manualRefs, codexEntries })}
                />
                <div className="panelStack">
                  <div className="panelHeader">
                    <p className="eyebrow">Selection</p>
                    {selections.length > 0 && <button className="button ghost dangerText filterClear" onClick={() => onRefsChange({ ...manualRefs, selections: [] })} type="button">Clear selection</button>}
                  </div>
                  <div className="chipRow">
                    {selections.length ? selections.map((selection, index) => {
                      const firstLine = selection.excerpt?.split(/\r?\n/)[0].trim() || 'Selected text';
                      const codexCount = selection.codexIds?.length ?? 0;
                      return (
                        <React.Fragment key={`${selection.sceneId}:${selection.from}:${selection.to}:${index}`}>
                          <button className="chip" onClick={() => setDetailView({ kind: 'excerpt', selection })} type="button">{firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine}</button>
                          {codexCount > 0 && <button className="chip" onClick={() => setDetailView({ kind: 'codex', selection })} type="button">{codexCount} codex {codexCount === 1 ? 'entry' : 'entries'}</button>}
                        </React.Fragment>
                      );
                    }) : <span className="emptyChips">No pinned selections</span>}
                  </div>
                </div>
                <div className="stats"><span>Mode: {mode}</span></div>
              </div>
            </div>
          </section>
          <form className="aiChatComposer" onSubmit={(event) => { event.preventDefault(); onRun(); }}>
            <textarea disabled={!ready || running} value={prompt} onChange={(event) => onPromptChange(event.target.value)} placeholder="Ask for an outline, a scene, or a continuation…" aria-label="Writing prompt" rows="7" />
            <div>{running && <button className="button secondary" onClick={onStop} type="button">Stop</button>}<button className="button primary" disabled={!ready || !prompt.trim() || running} type="submit">Run</button></div>
          </form>
        </div>
      </div>
    </aside>
    {detailView && <div className="modalOverlay" onClick={() => setDetailView(null)} role="presentation"><section className="welcomeCard modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={detailView.kind === 'excerpt' ? 'Selection details' : 'Selection codex entries'}>
      <header className="panelHeader"><h2>{detailView.kind === 'excerpt' ? 'Selected text' : 'Codex context'}</h2><button className="button ghost" onClick={() => setDetailView(null)} type="button">Close</button></header>
      {detailView.kind === 'excerpt' ? <div className="modalBody"><p className="notice">{detailChapter?.title || detailSelection?.chapterId || 'Unknown chapter'} · {detailScene?.heading || detailSelection?.sceneId || 'Unknown scene'}</p><div className="notice" style={{ whiteSpace: 'pre-wrap' }}>{detailSelection?.excerpt}</div></div> : <div className="modalBody codexHoverEntries">{detailCodexEntries.map((entry) => <section className="codexHoverEntry" key={entry.id}><div className="codexHoverEntryHeader"><div><h3>{entry.name}</h3>{entry.type && <p className={`entryType entryType${capitalize(entry.type)}`}>{entry.type}</p>}</div></div>{(entry.summary ?? entry.description) && <p className="notice">{entry.summary ?? entry.description}</p>}</section>)}</div>}
    </section></div>}
    </>
  );
}

function AiRefPicker({ label, items, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const values = Array.isArray(value) ? value.map(String) : [];
  const itemById = new Map(items.map((item) => [String(item.id), item]));
  const available = items.filter((item) => !values.includes(String(item.id)));
  const filtered = available.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 80);

  const addValue = (item) => {
    const id = String(item?.id ?? '').trim();
    if (!id || values.includes(id)) return;
    onChange([...values, id]);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="valuePicker">
      <p className="eyebrow">{label}</p>
      <div className="chipRow">
        {values.length ? values.map((id) => (
          <button className="chip" key={id} onClick={() => onChange(values.filter((valueId) => valueId !== id))} type="button">
            {itemById.get(id)?.title || id}
            <span>×</span>
          </button>
        )) : <span className="emptyChips">No {label.toLowerCase()}</span>}
      </div>
      <div className="valuePickerControls">
        <div className="comboBox">
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
              if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); addValue(filtered[0]); }
            }}
            placeholder={`Search ${label.toLowerCase()}`}
            aria-label={`Search ${label.toLowerCase()}`}
          />
          {open && <div className="comboList">
            {filtered.length ? filtered.map((item) => (
              <button key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => addValue(item)} type="button">{item.title}</button>
            )) : <span>No matching {label.toLowerCase()}</span>}
          </div>}
        </div>
      </div>
    </div>
  );
}

function AISettingsDialog({ onClose, onStatusChange, status }) {
  const [provider, setProvider] = useState(status?.provider ?? 'chatgpt');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [message, setMessage] = useState('');
  const [signIn, setSignIn] = useState(null);
  const signInPopupRef = useRef(null);

  useEffect(() => {
    if (!signIn?.flowId || signIn.state !== 'pending') return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/ai/signin/${encodeURIComponent(signIn.flowId)}`);
        const result = await response.json();
        if (cancelled) return;
        const state = result.state ?? (result.authed ? 'authed' : ['expired', 'failed'].includes(result.error) ? result.error : 'pending');
        if (state === 'authed') {
          setSignIn((current) => ({ ...current, state }));
          setMessage(result.note || 'ChatGPT connected.');
          await onStatusChange();
        } else if (state === 'expired' || state === 'failed') {
          setSignIn((current) => ({ ...current, state, error: result.error }));
          setMessage(result.error || `Sign-in ${state}. Try again.`);
        }
      } catch (error) {
        if (!cancelled) setMessage(error.message);
      }
    };
    poll();
    const intervalId = window.setInterval(poll, 3000);
    return () => { cancelled = true; window.clearInterval(intervalId); };
  }, [onStatusChange, signIn?.flowId, signIn?.state]);

  useEffect(() => {
    if (signIn?.state !== 'authed') return undefined;
    const timeoutId = window.setTimeout(onClose, 1800);
    return () => window.clearTimeout(timeoutId);
  }, [onClose, signIn?.state]);

  const submit = async () => {
    const popup = provider === 'chatgpt' ? window.open('', '_blank') : null;
    signInPopupRef.current = popup;
    const closePopup = () => {
      if (popup && !popup.closed) popup.close();
      if (signInPopupRef.current === popup) signInPopupRef.current = null;
    };
    try {
      const response = await fetch('/api/ai/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, apiKey, baseUrl }) });
      const result = await response.json();
      if (provider === 'chatgpt' && result.ok && result.pending) {
        if (popup && !popup.closed) popup.location.href = result.verificationUrl;
        setSignIn({ flowId: result.flowId, verificationUrl: result.verificationUrl, userCode: result.userCode, state: 'pending' });
        setMessage('Complete approval in ChatGPT to continue.');
        return;
      }
      closePopup();
      setMessage(result.hint || result.note || (result.ok ? 'Provider configured.' : result.error || 'Could not configure provider.'));
      await onStatusChange();
    } catch (error) {
      closePopup();
      setMessage(error.message);
    }
  };
  const changeProvider = (nextProvider) => { setProvider(nextProvider); setSignIn(null); setMessage(''); };
  return <div className="modalOverlay" role="presentation"><section className="welcomeCard modal" role="dialog" aria-modal="true" aria-label="AI settings">
    <header className="panelHeader"><h2>AI settings</h2><button className="button ghost" onClick={onClose} type="button">Close</button></header>
    <div className="stats"><span>{status?.provider ? `${status.provider} · ${status.model} · ${status.authed ? 'authenticated' : 'not authenticated'}` : 'No provider configured'}</span></div>
    {signIn?.state === 'pending' ? <div className="panelSection panelStack"><p className="eyebrow">ChatGPT verification code</p><div className="stats"><span><code>{signIn.userCode}</code></span></div><button className="button secondary" onClick={() => navigator.clipboard?.writeText(signIn.userCode)} type="button">Copy code</button><button className="button primary" onClick={() => window.open(signIn.verificationUrl, '_blank', 'noopener,noreferrer')} type="button">Open verification page</button><p className="notice">Waiting for approval…</p></div> : <>
      <div className="panelStack">{[['chatgpt', 'ChatGPT'], ['agentrouter', 'AgentRouter'], ['opencode', 'opencode'], ['custom', 'Custom API key']].map(([value, label]) => <label key={value}><input checked={provider === value} onChange={() => changeProvider(value)} type="radio" name="ai-provider" value={value} /> {label}</label>)}</div>
      {provider !== 'chatgpt' && <div className="codexFilters"><label className="eyebrow">API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>{provider === 'custom' && <label className="eyebrow">Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com" /></label>}</div>}
      <button className="button primary" onClick={submit} type="button">{provider === 'chatgpt' ? 'Sign in with ChatGPT' : 'Save provider'}</button>
    </>}
    {signIn?.state === 'authed' && <div className="migrationNotice notice">ChatGPT connected successfully.</div>}
    {signIn && signIn.state !== 'pending' && signIn.state !== 'authed' && <button className="button secondary" onClick={() => { setSignIn(null); setMessage(''); }} type="button">Try again</button>}
    {message && <p className="notice">{message}</p>}
  </section></div>;
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
          <button className="button primary" onClick={onSave} type="button">
            Save project
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

function SceneEditor({ chapterId, scene, sceneIndex, mentionIndex, onChange, onDelete, onEditorReady, onMentionHover, onMentionLeave }) {
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

  useEffect(() => {
    onEditorReady?.(scene.id, editor);
    return () => onEditorReady?.(scene.id, null);
  }, [editor, onEditorReady, scene.id]);

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

function WelcomeEmptyState({ onCreate, onImport, onOpen, onRestore, status, supported }) {
  if (!supported) {
    return (
      <main className="welcomeShell">
        <section className="welcomeCard">
          <p className="eyebrow">Novel Reader Editor</p>
          <h1>Chromium browser required</h1>
          <p>
            This editor saves a local .novel project using the browser File System Access API. That workflow is currently supported in Chromium browsers only.
          </p>
          <p>Use Chrome, Edge, Brave, or another Chromium-based browser to open or create a project.</p>
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
        <h1>Open a local Novel project</h1>
        <p>
          Open an existing .novel file, create a new one, or import a legacy markdown datasource folder. Your manuscript and codex stay on this computer.
        </p>
        <div className="welcomeActions">
          {onRestore && (
            <button className="button secondary" disabled={!supported} onClick={onRestore} type="button">
              Restore recent project
            </button>
          )}
          {onOpen && (
            <button className="button secondary" disabled={!supported} onClick={onOpen} type="button">
              Open project
            </button>
          )}
          {onImport && (
            <button className="button secondary" disabled={!supported} onClick={onImport} type="button">
              Import Markdown
            </button>
          )}
          <button className="button primary" disabled={!supported} onClick={onCreate} type="button">
            Create project
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
      if (item.entry.category === entry.category && item.entry.id === entry.id) continue;
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

function codexDraftKey(entry, projectId = 'unscoped') {
  return `${CODEX_DRAFT_PREFIX}${projectId}:${entry.category}:${entry.id}`;
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

function novelDraftKey(volumeId, projectId = 'unscoped') {
  return `${DRAFT_PREFIX}${projectId}:${volumeId}`;
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function findExcerptRange(doc, excerpt) {
  const target = normalizeWhitespace(excerpt);
  if (!target) return [];

  let source = '';
  const positions = [];
  let previousTextEnd = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    if (previousTextEnd != null && pos > previousTextEnd) {
      source += '\n';
      positions.push(null);
    }
    for (let index = 0; index < node.text.length; index += 1) {
      source += node.text[index];
      positions.push(pos + index);
    }
    previousTextEnd = pos + node.nodeSize;
  });

  let normalized = '';
  const normalizedPositions = [];
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/.test(source[index])) {
      if (normalized && !normalized.endsWith(' ')) {
        normalized += ' ';
        normalizedPositions.push(positions[index]);
      }
    } else {
      normalized += source[index];
      normalizedPositions.push(positions[index]);
    }
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    normalizedPositions.pop();
  }

  const ranges = [];
  let start = normalized.indexOf(target);
  while (start >= 0) {
    const from = normalizedPositions[start];
    const to = normalizedPositions[start + target.length - 1];
    if (from != null && to != null) ranges.push({ from, to: to + 1 });
    start = normalized.indexOf(target, start + 1);
  }
  return ranges;
}

function starterNovel(volumeLabel, title) {
  return {
    header: [`## ${title}`, ''],
    title,
    chapters: [
      {
        chapterNumber: 1,
        title: `${volumeLabel} Opening`,
        scenes: [{ heading: 'Scene 1', paragraphs: ['Start writing here...'] }]
      }
    ]
  };
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
