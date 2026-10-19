import { useEffect, useId, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { PageShell } from '../components/PageShell'
import { StatusChip } from '../components/StatusChip'
import {
  createProductionPlanListItemPresentation,
  sortProductionPlansForList,
  type ProductionPlanListItemPresentation,
} from '../components/planner/productionPlanListPresentation'
import type { ProductionPlan, ProductionPlanId } from '../domain/models/publicTypes'
import { productionPlanRepository } from '../db/repositories/productionPlanRepository'
import { RepositoryError } from '../db/repositoryError'
import { useSettingsStore } from '../stores/settingsStore'

export interface ProductionPlansPageDependencies {
  /**
   * Every persisted ProductionPlan, exactly as stored. The list is a read-only
   * projection of it (`docs/UI_FLOW.md` 11.5): nothing is reconstructed from a
   * BuildCandidate or a BuildListEntry, and no Planner or RNG prediction runs.
   */
  getAllProductionPlans(): Promise<ProductionPlan[]>
  /**
   * The guarded Draft delete (`ProductionPlanRepository.deleteDraftProductionPlan()`):
   * it re-reads the Plan inside its transaction and deletes only a stored
   * `draft`, so a Plan started after the list was drawn is never deleted.
   */
  deleteDraftProductionPlan(id: ProductionPlanId): Promise<void>
}

const defaultDependencies: ProductionPlansPageDependencies = {
  getAllProductionPlans: () => productionPlanRepository.getAllProductionPlans(),
  deleteDraftProductionPlan: (id) => productionPlanRepository.deleteDraftProductionPlan(id),
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; plans: ProductionPlan[] }
  | { status: 'error'; message: string }

/**
 * The delete failure by typed Repository code, never by parsing a message. A
 * refusal changes nothing in persistence, so the list is kept as it is and
 * the user is asked to reload it where the stored state moved on.
 */
function draftDeleteErrorMessage(error: unknown): string {
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case 'draft_plan_delete_not_allowed':
        return 'この生産計画はすでに開始または終了しているため、下書きとして削除できませんでした。一覧を再読み込みしてください。'
      case 'not_found':
        return 'この下書きはすでに存在しません。一覧を再読み込みしてください。'
      case 'draft_plan_conflict':
        return '未開始の生産計画が2件以上保存されているため、下書きを削除できませんでした。'
      default:
        break
    }
  }
  return '下書きの削除に失敗しました。もう一度お試しください。'
}

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/** One label / value pair of the card's definition list. */
function Fact({ label, children }: { label: string; children: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography
        component="dd"
        variant="body2"
        className="tabular-nums"
        sx={{ m: 0, overflowWrap: 'anywhere' }}
      >
        {children}
      </Typography>
    </Box>
  )
}

function ProductionPlanListItem({
  item,
  debugMode,
  deleteDisabled,
  onRequestDelete,
}: {
  item: ProductionPlanListItemPresentation
  debugMode: boolean
  deleteDisabled: boolean
  onRequestDelete(): void
}) {
  const headingId = useId()
  return (
    <Paper
      component="li"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ listStyle: 'none', p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Typography
          id={headingId}
          component="h3"
          variant="h3"
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, minWidth: 0 }}
        >
          <StatusChip component="span" label={item.statusLabel} tone={item.statusTone} />
          {item.statusNote !== null && (
            <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>
              {item.statusNote}
            </Typography>
          )}
        </Typography>

        {item.reasonLabels.length > 0 && (
          <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {item.reasonLabels.map((label) => (
              <Typography component="li" variant="body2" key={label} sx={{ overflowWrap: 'anywhere' }}>
                {label}
              </Typography>
            ))}
          </Stack>
        )}

        <Box
          component="dl"
          sx={{
            m: 0,
            display: 'grid',
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
            gap: 1.5,
          }}
        >
          <Fact label="作成日時">{item.createdAtLabel}</Fact>
          <Fact label="最終更新">{item.updatedAtLabel}</Fact>
          <Fact label="進捗">{`${item.completedStepCount} / ${item.totalStepCount} Step`}</Fact>
          <Fact label="目標武器">{`${item.targetWeaponCount}件`}</Fact>
        </Box>

        {debugMode && (
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            Plan ID: {item.planId}
          </Typography>
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Button
            component={RouterLink}
            to={`/plans/${item.planId}`}
            variant="outlined"
            aria-describedby={headingId}
            sx={actionSx}
          >
            詳細を見る
          </Button>
          {item.canResumeExecution && (
            <Button
              component={RouterLink}
              to={`/plans/${item.planId}/run`}
              variant="contained"
              aria-describedby={headingId}
              sx={actionSx}
            >
              実行ナビを再開
            </Button>
          )}
          {item.canDeleteDraft && (
            // The destructive control sits apart from the navigation ones: at
            // the far end of the row on PC and last in the column on a phone.
            <Button
              variant="outlined"
              color="error"
              disabled={deleteDisabled}
              onClick={onRequestDelete}
              aria-describedby={headingId}
              sx={{ ...actionSx, ml: { sm: 'auto' } }}
            >
              下書きを削除
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}

/** The confirmation every Draft delete needs (`docs/UI_FLOW.md` 11.5). */
function DeleteDraftDialog({
  open,
  deleting,
  onCancel,
  onConfirm,
}: {
  open: boolean
  deleting: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>この下書きを削除しますか？</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            まだ開始していない生産計画だけを削除します。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            ビルドリスト、候補、目標武器、所持武器は削除されません。
          </Typography>
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={deleting} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" color="error" onClick={onConfirm} disabled={deleting} sx={actionSx}>
          下書きを削除
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function ProductionPlansPage({
  dependencies = defaultDependencies,
}: { dependencies?: ProductionPlansPageDependencies }) {
  const debugMode = useSettingsStore((state) => state.debugMode)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [loadSequence, setLoadSequence] = useState(0)
  const [pendingDeleteId, setPendingDeleteId] = useState<ProductionPlanId | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const listHeadingId = useId()

  useEffect(() => {
    let active = true
    void dependencies
      .getAllProductionPlans()
      .then((plans) => {
        if (active) setState({ status: 'ready', plans })
      })
      .catch((caught: unknown) => {
        // A failed read is reported as such, never shown as "no Plans".
        if (active) {
          setState({
            status: 'error',
            message:
              caught instanceof Error && caught.message !== ''
                ? `生産計画一覧を読み込めませんでした: ${caught.message}`
                : '生産計画一覧を読み込めませんでした。',
          })
        }
      })
    return () => {
      active = false
    }
  }, [dependencies, loadSequence])

  /**
   * The explicit re-read, reached from the read-failure Alert and from the
   * delete-failure Alert alike. A delete failure is stale once the list is
   * re-read: the fresh list (or the fresh read error, which `state` carries)
   * is the only thing shown afterwards, never both.
   */
  const reload = () => {
    setDeleteError(null)
    setState({ status: 'loading' })
    setLoadSequence((sequence) => sequence + 1)
  }

  const cancelDelete = () => {
    if (!deleting) setPendingDeleteId(null)
  }

  const confirmDelete = async () => {
    if (pendingDeleteId === null || deleting) return
    const id = pendingDeleteId
    setDeleting(true)
    setDeleteError(null)
    try {
      await dependencies.deleteDraftProductionPlan(id)
      // Only the deleted Draft leaves the list; every other Plan stays as shown.
      setState((current) =>
        current.status === 'ready'
          ? { status: 'ready', plans: current.plans.filter((plan) => plan.id !== id) }
          : current,
      )
    } catch (caught: unknown) {
      setDeleteError(draftDeleteErrorMessage(caught))
    } finally {
      setDeleting(false)
      setPendingDeleteId(null)
    }
  }

  const items =
    state.status === 'ready'
      ? sortProductionPlansForList(state.plans).map(createProductionPlanListItemPresentation)
      : []

  return (
    <PageShell
      title="生産計画"
      description="現在の下書き、実行中の計画、対応が必要な計画、完了・終了した履歴を確認します。"
    >
      <Stack spacing={{ xs: 2, md: 3 }}>
        {state.status === 'loading' && (
          <LinearProgress aria-label="生産計画一覧を読み込み中" />
        )}
        {state.status === 'error' && (
          <Alert severity="error">
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {state.message}
              </Typography>
              <Button variant="outlined" color="inherit" onClick={reload} sx={{ minHeight: 44 }}>
                再読み込み
              </Button>
            </Stack>
          </Alert>
        )}
        {deleteError !== null && (
          <Alert severity="error" onClose={() => setDeleteError(null)}>
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {deleteError}
              </Typography>
              <Button variant="outlined" color="inherit" onClick={reload} sx={{ minHeight: 44 }}>
                再読み込み
              </Button>
            </Stack>
          </Alert>
        )}

        {state.status === 'ready' && items.length === 0 && (
          <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography>生産計画はまだありません。</Typography>
              <Typography variant="body2" color="text.secondary">
                ビルドリストから生産計画を作成できます。
              </Typography>
              <Button component={RouterLink} to="/build-list" variant="outlined" sx={actionSx}>
                ビルドリストを開く
              </Button>
            </Stack>
          </Paper>
        )}

        {state.status === 'ready' && items.length > 0 && (
          <Box component="section" aria-labelledby={listHeadingId} sx={{ minWidth: 0 }}>
            <Typography id={listHeadingId} component="h2" variant="h2" sx={{ mb: 1.5 }}>
              生産計画一覧
            </Typography>
            <Stack component="ul" aria-labelledby={listHeadingId} spacing={1.5} sx={{ m: 0, p: 0 }}>
              {items.map((item) => (
                <ProductionPlanListItem
                  key={item.planId}
                  item={item}
                  debugMode={debugMode}
                  deleteDisabled={deleting || pendingDeleteId !== null}
                  onRequestDelete={() => {
                    setDeleteError(null)
                    setPendingDeleteId(item.planId)
                  }}
                />
              ))}
            </Stack>
          </Box>
        )}
      </Stack>

      <DeleteDraftDialog
        open={pendingDeleteId !== null}
        deleting={deleting}
        onCancel={cancelDelete}
        onConfirm={() => void confirmDelete()}
      />
    </PageShell>
  )
}
