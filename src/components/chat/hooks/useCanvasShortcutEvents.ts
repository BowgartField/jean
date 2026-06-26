import { useCallback, useEffect, useState } from 'react'
import type { SessionCardData } from '../session-card-utils'
import type { LabelData, Session } from '@/types/chat'
import type { ApprovalContext } from '../PlanDialog'
import { useUIStore } from '@/store/ui-store'
import { toast } from 'sonner'
import { findLatestRecapSection } from '../recap-utils'
import { invoke } from '@/lib/transport'

interface UseCanvasShortcutEventsOptions {
  /** Currently selected card (null if none selected) */
  selectedCard: SessionCardData | null
  /** Whether shortcuts are enabled (disable when modal open) */
  enabled: boolean
  /** Worktree ID for approval context */
  worktreeId: string
  /** Worktree path for approval context */
  worktreePath: string
  /** Callback for plan approval */
  onPlanApproval: (card: SessionCardData, updatedPlan?: string) => void
  /** Callback for YOLO plan approval */
  onPlanApprovalYolo: (card: SessionCardData, updatedPlan?: string) => void
  /** Callback for clear context approval (new session with plan in yolo mode) */
  onClearContextApproval: (card: SessionCardData, updatedPlan?: string) => void
  /** Callback for clear context approval (new session with plan in build mode) */
  onClearContextApprovalBuild: (
    card: SessionCardData,
    updatedPlan?: string
  ) => void
  /** Callback for worktree approval (new worktree with plan in build mode) */
  onWorktreeApproval?:
    | ((card: SessionCardData, updatedPlan?: string) => void)
    | null
  /** Callback for worktree approval (new worktree with plan in yolo mode) */
  onWorktreeApprovalYolo?:
    | ((card: SessionCardData, updatedPlan?: string) => void)
    | null
  /** If true, skip handling toggle-session-label event (caller handles it) */
  skipLabelHandling?: boolean
}

interface UseCanvasShortcutEventsResult {
  /** Plan dialog file path (if open) */
  planDialogPath: string | null
  /** Plan dialog content (if open, for inline plans) */
  planDialogContent: string | null
  /** Approval context for the open plan dialog */
  planApprovalContext: ApprovalContext | null
  /** The card associated with the open plan dialog */
  planDialogCard: SessionCardData | null
  /** Close plan dialog */
  closePlanDialog: () => void
  /** Recap dialog content (if open) */
  recapDialogContent: string | null
  /** Close recap dialog */
  closeRecapDialog: () => void
  /** Handle plan view button click */
  handlePlanView: (card: SessionCardData) => void
  /** Whether the label modal is open */
  isLabelModalOpen: boolean
  /** Session ID for the label modal */
  labelModalSessionId: string | null
  /** Current label for the label modal session */
  labelModalCurrentLabel: LabelData | null
  /** Close label modal */
  closeLabelModal: () => void
  /** Open label modal for a card */
  handleOpenLabelModal: (card: SessionCardData) => void
}

/**
 * Shared hook for canvas shortcut event handling.
 * Listens for approve-plan, approve-plan-yolo, open-plan events.
 */
export function useCanvasShortcutEvents({
  selectedCard,
  enabled,
  worktreeId,
  worktreePath,
  onPlanApproval,
  onPlanApprovalYolo,
  onClearContextApproval,
  onClearContextApprovalBuild,
  onWorktreeApproval,
  onWorktreeApprovalYolo,
  skipLabelHandling,
}: UseCanvasShortcutEventsOptions): UseCanvasShortcutEventsResult {
  // Plan dialog state
  const [planDialogPath, setPlanDialogPath] = useState<string | null>(null)
  const [planDialogContent, setPlanDialogContent] = useState<string | null>(
    null
  )
  const [planApprovalContext, setPlanApprovalContext] =
    useState<ApprovalContext | null>(null)
  const [planDialogCard, setPlanDialogCard] = useState<SessionCardData | null>(
    null
  )
  const [recapDialogContent, setRecapDialogContent] = useState<string | null>(
    null
  )

  // Label modal state
  const [labelModalSessionId, setLabelModalSessionId] = useState<string | null>(
    null
  )
  const [labelModalCurrentLabel, setLabelModalCurrentLabel] =
    useState<LabelData | null>(null)

  // Handle plan view
  const handlePlanView = useCallback(
    (card: SessionCardData) => {
      if (card.planFilePath) {
        setPlanDialogPath(card.planFilePath)
        setPlanDialogContent(null)
      } else if (card.planContent) {
        setPlanDialogContent(card.planContent)
        setPlanDialogPath(null)
      }

      // Set approval context for the dialog
      setPlanApprovalContext({
        worktreeId,
        worktreePath,
        sessionId: card.session.id,
        pendingPlanMessageId: card.pendingPlanMessageId,
      })
      setPlanDialogCard(card)
    },
    [worktreeId, worktreePath]
  )

  // Close handlers
  const closePlanDialog = useCallback(() => {
    setPlanDialogPath(null)
    setPlanDialogContent(null)
    setPlanApprovalContext(null)
    setPlanDialogCard(null)
  }, [])

  const closeRecapDialog = useCallback(() => {
    setRecapDialogContent(null)
  }, [])

  const closeLabelModal = useCallback(() => {
    setLabelModalSessionId(null)
    setLabelModalCurrentLabel(null)
  }, [])

  const handleOpenLabelModal = useCallback((card: SessionCardData) => {
    setLabelModalSessionId(card.session.id)
    setLabelModalCurrentLabel(card.label)
  }, [])

  // Listen for keyboard shortcut events
  useEffect(() => {
    if (!enabled || !selectedCard) return

    const handleApprovePlanEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onPlanApproval(selectedCard)
      }
    }

    const handleApprovePlanYoloEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onPlanApprovalYolo(selectedCard)
      }
    }

    const handleClearContextApproveEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onClearContextApproval(selectedCard)
      }
    }

    const handleClearContextApproveBuildEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onClearContextApprovalBuild(selectedCard)
      }
    }

    const handleWorktreeApproveEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending &&
        onWorktreeApproval
      ) {
        onWorktreeApproval(selectedCard)
      }
    }

    const handleWorktreeApproveYoloEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending &&
        onWorktreeApprovalYolo
      ) {
        onWorktreeApprovalYolo(selectedCard)
      }
    }

    const handleOpenPlanEvent = () => {
      if (selectedCard.planFilePath || selectedCard.planContent) {
        handlePlanView(selectedCard)
      } else {
        toast.info('No plan available for this session')
      }
    }

    const handleOpenRecapEvent = async () => {
      let messages = selectedCard.session.messages
      if (messages.length === 0 && selectedCard.session.message_count) {
        try {
          const session = await invoke<Session>('get_session', {
            worktreeId,
            worktreePath,
            sessionId: selectedCard.session.id,
          })
          messages = session.messages
        } catch (error) {
          toast.error(`Failed to load session recap: ${error}`)
          return
        }
      }
      const recap = findLatestRecapSection(messages)
      if (recap) {
        setRecapDialogContent(recap)
      } else {
        toast.info('No recap available for this session yet')
      }
    }

    const handleToggleLabelEvent = () => {
      setLabelModalSessionId(selectedCard.session.id)
      setLabelModalCurrentLabel(selectedCard.label)
    }

    window.addEventListener('approve-plan', handleApprovePlanEvent)
    window.addEventListener('approve-plan-yolo', handleApprovePlanYoloEvent)
    window.addEventListener(
      'approve-plan-clear-context',
      handleClearContextApproveEvent
    )
    window.addEventListener(
      'approve-plan-clear-context-build',
      handleClearContextApproveBuildEvent
    )
    window.addEventListener(
      'approve-plan-worktree-build',
      handleWorktreeApproveEvent
    )
    window.addEventListener(
      'approve-plan-worktree-yolo',
      handleWorktreeApproveYoloEvent
    )
    window.addEventListener('open-plan', handleOpenPlanEvent)
    window.addEventListener('open-recap', handleOpenRecapEvent)
    if (!skipLabelHandling) {
      window.addEventListener('toggle-session-label', handleToggleLabelEvent)
    }

    return () => {
      window.removeEventListener('approve-plan', handleApprovePlanEvent)
      window.removeEventListener(
        'approve-plan-yolo',
        handleApprovePlanYoloEvent
      )
      window.removeEventListener(
        'approve-plan-clear-context',
        handleClearContextApproveEvent
      )
      window.removeEventListener(
        'approve-plan-clear-context-build',
        handleClearContextApproveBuildEvent
      )
      window.removeEventListener(
        'approve-plan-worktree-build',
        handleWorktreeApproveEvent
      )
      window.removeEventListener(
        'approve-plan-worktree-yolo',
        handleWorktreeApproveYoloEvent
      )
      window.removeEventListener('open-plan', handleOpenPlanEvent)
      window.removeEventListener('open-recap', handleOpenRecapEvent)
      if (!skipLabelHandling) {
        window.removeEventListener(
          'toggle-session-label',
          handleToggleLabelEvent
        )
      }
    }
  }, [
    enabled,
    selectedCard,
    onPlanApproval,
    onPlanApprovalYolo,
    onClearContextApproval,
    onClearContextApprovalBuild,
    onWorktreeApproval,
    onWorktreeApprovalYolo,
    handlePlanView,
    worktreeId,
    worktreePath,
    skipLabelHandling,
  ])

  return {
    planDialogPath,
    planDialogContent,
    planApprovalContext,
    planDialogCard,
    closePlanDialog,
    recapDialogContent,
    closeRecapDialog,
    handlePlanView,
    isLabelModalOpen: !!labelModalSessionId,
    labelModalSessionId,
    labelModalCurrentLabel,
    closeLabelModal,
    handleOpenLabelModal,
  }
}
