'use client';

import { useMemo, useCallback, useRef } from 'react';
import useVoice2RxStore from '@/store/store';
import SessionTabRow from '@/features/session/components/session-tab-row';
import SessionContent from '@/features/session/components/session-content';
import { AddOrConvertPopover } from '@/features/session/components/dialogs/add-or-convert-popover';
import LinkPastSessionsDialog from '@/features/session/components/dialogs/link-past-sessions-dialog';
import { downloadDocument, printDocument } from '@/features/session/services/document-service';
import { useCapabilities } from '@/platform';
import type { SessionDocumentHandle } from './tabs/session-document';
import { TabFooter } from './tabs/tab-footer';
import {
  getContextFooterConfig,
  getDocumentFooterConfig,
  getTranscriptFooterConfig,
  getErrorFooterConfig,
  getChunkLimitFooterConfig,
} from '../config/tab-footer-config';
import type { TabFooterConfig } from '../config/tab-footer-config';
import { useErrorHandlers } from '../hooks/use-error-handlers';
import { useSessionLifecycle } from '../hooks/use-session-lifecycle';
import { useContextEditor } from '../hooks/context/use-context-editor';
import { useSessionContext } from '../hooks/context/use-session-context';
import { useSessionTabs } from '../hooks/use-session-tabs';
import { useSessionView } from '../hooks/use-session-view';
import { copyMarkdownToClipboard } from '../utils/copy-output-utils';
import { toast } from 'sonner';
import { ContextTabContentHandle } from './tabs/context-tab-content';

interface SessionBodyProps {
  sessionId: string;
  onAddTranscript?: () => void;
  isLimitExceeded?: boolean;
}

const EMPTY_DOCUMENTS: never[] = [];
const EMPTY_TRANSCRIPT: never[] = [];

const SESSION_LIMIT_TOAST = 'Session limit reached.';

const SessionBody = ({ sessionId, onAddTranscript, isLimitExceeded }: SessionBodyProps) => {
  const { showAddButton, showConvertOption, showGenerateTranscript, getFooterMode } =
    useSessionView(sessionId);

  const documents = useVoice2RxStore(
    (s) => s.sessionV2ContentById[sessionId]?.documents ?? EMPTY_DOCUMENTS
  );
  const transcriptDocs = useVoice2RxStore(
    (s) => s.sessionV2ContentById[sessionId]?.transcript ?? EMPTY_TRANSCRIPT
  );
  const selectedTranscriptLang = useVoice2RxStore(
    (s) => s.sessionV2ContentById[sessionId]?.ui?.selected_transcript_lang || ''
  );
  const userSelectedTemplatesList = useVoice2RxStore((s) => s.userSelectedTemplatesList);

  const {
    activeTab,
    setActiveTab,
    tabs,
    handleAddNote,
    handleDeleteTab,
    handleRenameTab,
    activeStreamTabs,
    finishedStreamTabs,
    streamDocIds,
    streamAgUiRun,
    handleStreamFinished,
    handleStreamDocumentId,
    addPendingTab,
    removePendingTab,
    autoStreamDocId,
    clearAutoStreamDocId,
    mountedDocIds,
  } = useSessionTabs(sessionId);

  const streamRef = useRef<SessionDocumentHandle>(null);
  const documentRef = useRef<SessionDocumentHandle>(null);
  const contextRef = useRef<ContextTabContentHandle>(null);

  const saveStatus = useVoice2RxStore(
    (s) => s.sessionV2ContentById[sessionId]?.ui?.save_status_by_doc?.[activeTab] || 'idle'
  );

  const { ensureContextDocument } = useContextEditor({ sessionId });
  const sessionContext = useSessionContext({ sessionId });
  const { handleTryAgain, handleDiscard, handleContinueRecording } = useErrorHandlers(sessionId);
  const { endRecording } = useSessionLifecycle();

  // Template runs re-read the transcript server-side; without a stored
  // transcript file (no presigned get_url) the run 404s, so don't offer
  // conversion.
  const hasTranscript = transcriptDocs.some((t) => !!t.get_url || !!t.content);
  const canConvert = showConvertOption && hasTranscript;

  const isContextTab = activeTab === 'context';
  const isTranscriptTab = activeTab === 'transcript';
  const isStreamTab = activeTab.startsWith('stream:');
  const activeDoc = documents.find((d) => d.document_id === activeTab);

  // Resolves which transcript doc to show based on selected language
  const activeTranscriptDoc = useMemo(() => {
    if (!isTranscriptTab || transcriptDocs.length === 0) return null;
    const existingLangs = new Set(transcriptDocs.map((t) => t.lang || 'raw'));
    const activeLang =
      selectedTranscriptLang && existingLangs.has(selectedTranscriptLang)
        ? selectedTranscriptLang
        : transcriptDocs[0]?.lang || 'raw';
    return transcriptDocs.find((t) => (t.lang || 'raw') === activeLang) || transcriptDocs[0];
  }, [isTranscriptTab, transcriptDocs, selectedTranscriptLang]);

  // Saves current tab content before switching, closes context dialogs
  const handleTabChange = useCallback(
    async (tabId: string) => {
      clearAutoStreamDocId();
      if (isStreamTab && finishedStreamTabs.has(activeTab)) {
        streamRef.current?.save();
      } else if (activeDoc) {
        // Only save dirty docs
        const status =
          useVoice2RxStore.getState().sessionV2ContentById[sessionId]?.ui?.save_status_by_doc?.[
            activeTab
          ];
        if (status === 'typing') documentRef.current?.save();
      } else if (isContextTab) {
        void contextRef.current?.save();
      }
      setActiveTab(tabId);

      if (tabId === 'context') {
        await ensureContextDocument();
      }
    },
    [
      sessionId,
      isContextTab,
      isStreamTab,
      activeDoc,
      activeTab,
      finishedStreamTabs,
      clearAutoStreamDocId,
      setActiveTab,
      ensureContextDocument,
    ]
  );

  // Download needs a native HTML->PDF path; web falls back to the print dialog's Save as PDF.
  const canExportPdf = useCapabilities().has('native-pdf-export');

  const handleDownloadDocument = useCallback(
    async (documentId: string, documentName?: string) => {
      const saved = await downloadDocument({ documentId, sessionId, documentName });
      if (!saved) toast.error('Could not prepare the PDF. Try Print instead.');
    },
    [sessionId]
  );

  // Copies active document markdown to clipboard
  const handleCopyDocument = useCallback(async () => {
    const md = documentRef.current?.getMarkdown() || activeDoc?.content;
    if (!md) return;
    await copyMarkdownToClipboard(md);
  }, [activeDoc]);

  // Renders the "Add or convert" popover content for the tab row
  const renderAddContent = (close: () => void) => (
    <AddOrConvertPopover
      sessionId={sessionId}
      close={close}
      addPendingTab={addPendingTab}
      removePendingTab={removePendingTab}
      setActiveTab={setActiveTab}
      onAddNote={() => {
        close();
        handleAddNote();
      }}
      onAddTranscript={
        onAddTranscript
          ? () => {
              close();
              onAddTranscript();
            }
          : undefined
      }
      templates={userSelectedTemplatesList}
      onStreamTemplate={canConvert ? (template) => streamAgUiRun(template, close) : undefined}
      showConvertOption={canConvert}
      showGenerateTranscriptOption={showGenerateTranscript}
    />
  );

  // Builds footer config based on active tab type and session phase
  const activeDocStatus = isTranscriptTab ? activeTranscriptDoc?.status : activeDoc?.status;
  const footerMode = getFooterMode(activeTab, activeDocStatus);

  const footerConfig = ((): TabFooterConfig | null => {
    switch (footerMode) {
      case 'chunk-limit':
        return getChunkLimitFooterConfig({
          onEndRecording: endRecording,
          onContinueRecording: handleContinueRecording,
          onDiscard: handleDiscard,
        });

      case 'error':
        return getErrorFooterConfig({
          onTryAgain: handleTryAgain,
          onDiscard: handleDiscard,
        });

      case 'stream': {
        const isDone = finishedStreamTabs.has(activeTab);
        const streamDocId = streamDocIds.get(activeTab) || streamRef.current?.getDocumentId() || '';
        return getDocumentFooterConfig({
          onCopy: async () => {
            const md = streamRef.current?.getMarkdown();
            if (md) await copyMarkdownToClipboard(md);
          },
          onPrint: async () => {
            const docId = streamDocIds.get(activeTab) || streamRef.current?.getDocumentId() || '';
            if (docId) await printDocument({ documentId: docId, sessionId });
          },
          onDownload: canExportPdf
            ? async () => {
                const docId =
                  streamDocIds.get(activeTab) || streamRef.current?.getDocumentId() || '';
                if (docId) await handleDownloadDocument(docId);
              }
            : undefined,
          saveStatus: isDone ? saveStatus : 'generating',
          copyDisabled: !isDone,
          printDisabled: !isDone || !streamDocId,
          downloadDisabled: !isDone || !streamDocId,
        });
      }

      case 'context':
        return getContextFooterConfig({
          onLinkPastSessions: sessionContext.handleOpenLinkDialog,
          saveStatus,
          overlay: sessionContext.showLinkDialog ? (
            <div className="absolute bottom-full left-2 mb-2 z-10">
              <LinkPastSessionsDialog
                sessions={sessionContext.pastSessions}
                loading={sessionContext.loadingPastSessions}
                onClose={() => sessionContext.setShowLinkDialog(false)}
                onAddContext={sessionContext.handleAddLinkedSessions}
                onRemoveContext={sessionContext.handleRemoveLinkedSession}
                alreadyLinkedIds={sessionContext.linkedSessions.map((s) => s.txn_id)}
              />
            </div>
          ) : undefined,
        });

      case 'transcript':
        return getTranscriptFooterConfig({
          onCopy: async () => {
            if (activeTranscriptDoc?.content) {
              await copyMarkdownToClipboard(activeTranscriptDoc.content);
            }
          },
          copyDisabled: !activeTranscriptDoc?.content,
        });

      case 'document': {
        if (!activeDoc) return null;
        const hasContent =
          activeDoc.content !== '' && (!!activeDoc.content || activeDoc.status === 'success');
        return getDocumentFooterConfig({
          onCopy: handleCopyDocument,
          onPrint: async () => {
            await printDocument({ documentId: activeDoc.document_id, sessionId });
          },
          onDownload: canExportPdf
            ? async () => {
                await handleDownloadDocument(activeDoc.document_id, activeDoc.document_name);
              }
            : undefined,
          saveStatus,
          copyDisabled: !hasContent,
          printDisabled: !hasContent,
          downloadDisabled: !hasContent,
        });
      }

      case 'doc-error':
      case 'none':
      default:
        return null;
    }
  })();

  return (
    <div className="w-full px-4 flex flex-col flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-h-0 bg-white border border-[#D1D1D1] border-b-0 rounded-t-xl overflow-hidden">
        <SessionTabRow
          tabs={tabs}
          activeTabId={activeTab}
          onTabChange={handleTabChange}
          showAddButton={showAddButton}
          onRenameTab={handleRenameTab}
          onDeleteTab={handleDeleteTab}
          addButtonLabel="Add or convert"
          disabledTabIds={isLimitExceeded ? ['context'] : undefined}
          onDisabledTabClick={isLimitExceeded ? () => toast.info(SESSION_LIMIT_TOAST) : undefined}
          renderAddPopoverContent={renderAddContent}
        />

        <SessionContent
          sessionId={sessionId}
          activeTab={activeTab}
          tabs={tabs}
          activeStreamTabs={activeStreamTabs}
          mountedDocIds={mountedDocIds}
          autoStreamDocId={autoStreamDocId}
          onStreamFinished={handleStreamFinished}
          onStreamDocumentId={handleStreamDocumentId}
          streamRef={streamRef}
          documentRef={documentRef}
          contextRef={contextRef}
          linkedSessions={sessionContext.linkedSessions}
          onRemoveLinkedSession={sessionContext.handleRemoveLinkedSession}
        />

        {footerConfig && <TabFooter config={footerConfig} />}
      </div>
    </div>
  );
};

export default SessionBody;
