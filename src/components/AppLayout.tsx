import { useRef, useState, type MouseEvent } from 'react'
import {
  AppBar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
  Stack,
  SvgIcon,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { matchPath, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useSettingsStore } from '../stores/settingsStore'
import { AppUpdateNotice, type AppUpdateNoticeDependencies } from './appVersion/AppUpdateNotice'

const drawerWidth = 240

interface NavigationItem {
  label: string
  to: string
  /** Only the Dashboard needs `end`, since every other path is a distinct leaf. */
  end?: boolean
}

interface NavigationGroup {
  /** `null` renders no `ListSubheader`; used for the single Dashboard entry point. */
  label: string | null
  items: NavigationItem[]
}

/**
 * Primary navigation: the everyday screens, grouped by purpose
 * (`docs/UI_FLOW.md` 2.1). Rendered above the Drawer divider.
 *
 * Every group is shown on both PC and smartphone: the device never narrows
 * which screens are reachable (`docs/UI_FLOW.md` 3.1). 生産計画 leads to the
 * Production Plan list (`/plans`); it is also the active entry on a Plan's
 * detail (`/plans/:planId`) and its Execution Navigator (`/plans/:planId/run`),
 * because `NavLink` matches those nested paths without `end`. The Execution
 * Navigator has no entry of its own: it is reached from a Plan once one runs.
 */
const primaryNavigationGroups: NavigationGroup[] = [
  { label: null, items: [{ label: 'ダッシュボード', to: '/', end: true }] },
  {
    label: '管理',
    items: [
      { label: '所持武器', to: '/owned-weapons' },
      { label: '目標武器', to: '/target-weapons' },
    ],
  },
  {
    label: '計画',
    items: [
      { label: '候補検索', to: '/search' },
      { label: 'ビルドリスト', to: '/build-list' },
      { label: '生産計画', to: '/plans' },
    ],
  },
]

/**
 * One-time setup screens (`docs/UI_FLOW.md` 2.1), rendered below the Drawer
 * divider so daily work sits above them. 使い方 (`/guide`, `docs/UI_FLOW.md`
 * 2.2) is not a Domain operation, so it joins no group and sits directly
 * above 設定.
 */
const setupNavigationGroups: NavigationGroup[] = [
  {
    label: '初期設定',
    items: [
      { label: 'RNG状態設定', to: '/rng' },
      { label: '通常アーティアカウンター', to: '/normal-counters' },
    ],
  },
]

interface RouteTitle {
  pattern: string
  end?: boolean
  label: string
}

/**
 * Route -> current page label lookup, used only to identify the current page
 * in the AppBar.
 *
 * Covers every path `App.tsx` registers, including the dynamic Production
 * Plan / Execution Navigator routes below the Production Plan list. Order
 * matters: a more specific pattern is listed before a less specific one that
 * would also match it (`/plans/:planId/run` before `/plans/:planId`, and both
 * before the generic `/plans`). This is a read-only presentation lookup; it
 * does not change any Router path or navigation semantics.
 */
const routeTitles: RouteTitle[] = [
  { pattern: '/', end: true, label: 'ダッシュボード' },
  { pattern: '/rng', label: 'RNG状態設定' },
  { pattern: '/normal-counters', label: '通常アーティアカウンター' },
  { pattern: '/owned-weapons', label: '所持武器' },
  { pattern: '/target-weapons', label: '目標武器' },
  { pattern: '/search', label: '候補検索' },
  { pattern: '/build-list', label: 'ビルドリスト' },
  { pattern: '/plans/:planId/run', label: '実行ナビゲーション' },
  { pattern: '/plans/:planId', label: '生産計画' },
  { pattern: '/plans', label: '生産計画' },
  { pattern: '/guide', label: '使い方' },
  { pattern: '/settings', label: '設定' },
  { pattern: '/debug', label: 'デバッグ' },
]

function useCurrentPageLabel(): string | null {
  const { pathname } = useLocation()
  const matched = routeTitles.find((route) =>
    matchPath({ path: route.pattern, end: route.end ?? true }, pathname),
  )
  return matched?.label ?? null
}

function MenuIcon() {
  return (
    <SvgIcon>
      <path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z" />
    </SvgIcon>
  )
}

export function AppLayout({
  appUpdate,
}: {
  /** The stale client notice's checker and reload action; injectable for tests. */
  appUpdate?: AppUpdateNoticeDependencies
} = {}) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const [mobileOpen, setMobileOpen] = useState(false)
  const debugMode = useSettingsStore((state) => state.debugMode)
  const currentPageLabel = useCurrentPageLabel()
  const mainRef = useRef<HTMLElement>(null)

  /**
   * Moves keyboard focus straight to the page content, past the AppBar and
   * the Drawer navigation. The link keeps a conventional `#main-content`
   * href for assistive technology, but the default jump is suppressed
   * because a hash change would be read by the HashRouter as a route
   * change; focus is moved programmatically instead, so Router semantics
   * are untouched.
   */
  const skipToMainContent = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    mainRef.current?.focus()
  }

  /**
   * Shared active/hover styling for every navigation link.
   *
   * The active indicator combines a left border, a background tint, and a
   * bolder + coloured label - never colour alone. The border is always
   * reserved at its active width (transparent when inactive) so becoming
   * active never shifts the label position. The keyboard focus ring comes
   * from the theme-wide `focusVisible` setting, the same ring every other
   * MUI control shows, so no per-link outline is defined here.
   */
  const navigationItemSx = {
    borderLeft: '3px solid transparent',
    '&:hover': { bgcolor: 'action.hover' },
    '&.active': {
      bgcolor: 'action.selected',
      borderLeftColor: 'primary.main',
      '& .MuiListItemText-primary': {
        color: 'primary.main',
        fontWeight: 600,
      },
    },
  } as const

  const renderNavigationItem = (item: NavigationItem) => (
    <ListItemButton
      key={item.to}
      component={NavLink}
      to={item.to}
      end={item.end}
      onClick={() => setMobileOpen(false)}
      sx={navigationItemSx}
    >
      {/* A long label such as 通常アーティアカウンター wraps inside the
          Drawer's usable width instead of widening the navigation. */}
      <ListItemText primary={item.label} sx={{ minWidth: 0, overflowWrap: 'anywhere' }} />
    </ListItemButton>
  )

  const renderNavigationGroup = (group: NavigationGroup, groupIndex: number) => (
    <List
      key={group.label ?? `group-${groupIndex}`}
      subheader={
        group.label ? (
          <ListSubheader component="div" disableSticky>
            {group.label}
          </ListSubheader>
        ) : undefined
      }
    >
      {group.items.map(renderNavigationItem)}
    </List>
  )

  /*
    The navigation content is a block child that fills the Drawer paper's
    *usable* width. It must not repeat `drawerWidth` as its own fixed width:
    the paper is `overflow-y: auto`, so once its content is taller than the
    viewport a vertical scrollbar takes part of the 240px paper width, and a
    240px-wide child would then overflow horizontally and show a horizontal
    scrollbar (`docs/UI_FLOW.md` 2.1). Vertical scrolling stays allowed.
  */
  const navigationContent = (
    <Box sx={{ minWidth: 0 }} role="navigation" aria-label="メインナビゲーション">
      <Toolbar>
        <Typography variant="subtitle1">Gogma Artian Planner</Typography>
      </Toolbar>
      <Divider />
      {primaryNavigationGroups.map(renderNavigationGroup)}
      <Divider />
      {setupNavigationGroups.map(renderNavigationGroup)}
      <List>
        {renderNavigationItem({ label: '使い方', to: '/guide' })}
        {renderNavigationItem({ label: '設定', to: '/settings' })}
        {debugMode && renderNavigationItem({ label: 'デバッグ', to: '/debug' })}
      </List>
    </Box>
  )

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex' }}>
      {/*
        Skip link: visually hidden until it receives keyboard focus, then
        shown above the AppBar so it is the first Tab stop on every page.
        It is never visible to a pointer user and takes no layout space, so
        the smartphone layout is unaffected.
      */}
      <Box
        component="a"
        href="#main-content"
        onClick={skipToMainContent}
        sx={{
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: theme.zIndex.appBar + 1,
          px: 2,
          py: 1,
          borderRadius: 1,
          bgcolor: 'background.paper',
          color: 'primary.main',
          border: `1px solid ${theme.palette.primary.main}`,
          fontWeight: 600,
          textDecoration: 'none',
          // Off-screen (not display:none) so it stays in the Tab order.
          transform: 'translateY(-200%)',
          '&:focus-visible': {
            transform: 'none',
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 2,
          },
        }}
      >
        メインコンテンツへ移動
      </Box>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          ml: { md: `${drawerWidth}px` },
          width: { md: `calc(100% - ${drawerWidth}px)` },
        }}
      >
        <Toolbar>
          {!isDesktop && (
            <IconButton
              edge="start"
              aria-label="ナビゲーションを開く"
              onClick={() => setMobileOpen(true)}
              sx={{ mr: 1 }}
            >
              <MenuIcon />
            </IconButton>
          )}
          {/*
            Hierarchy: the current page name is always shown and never
            truncated away; the app's thematic brand line is secondary and
            only joins it once there is room (sm and up), so the AppBar
            still identifies "where am I" on the narrowest phones without
            growing past its existing single-row height.
          */}
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', minWidth: 0 }}>
            {currentPageLabel ? (
              <>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  noWrap
                  sx={{ display: { xs: 'none', sm: 'block' } }}
                >
                  Monster Hunter Wilds ／
                </Typography>
                <Typography variant="subtitle1" component="span" noWrap sx={{ minWidth: 0 }}>
                  {currentPageLabel}
                </Typography>
              </>
            ) : (
              <Typography variant="subtitle1" noWrap>
                Monster Hunter Wilds
              </Typography>
            )}
          </Stack>
        </Toolbar>
      </AppBar>

      {/*
        A plain layout box, not a second landmark: the Drawer content itself
        is the one `navigation` landmark. On smartphone the temporary Drawer
        renders in a portal, so a `<nav>` here would be an empty landmark.
      */}
      <Box sx={{ width: { md: drawerWidth }, flexShrink: { md: 0 } }}>
        {isDesktop ? (
          <Drawer
            variant="permanent"
            open
            sx={{ '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box' } }}
          >
            {navigationContent}
          </Drawer>
        ) : (
          <Drawer
            variant="temporary"
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box' } }}
          >
            {navigationContent}
          </Drawer>
        )}
      </Box>

      <Box
        component="main"
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        sx={{ flexGrow: 1, minWidth: 0, pt: 8, px: { xs: 2, sm: 3, lg: 5 }, pb: 5, outline: 'none' }}
      >
        <Box sx={{ width: '100%', maxWidth: 1120, mx: 'auto', pt: { xs: 3, md: 4 } }}>
          {/* Global, in-flow notice above every page (`docs/UI_FLOW.md` 3.6):
              it pushes the page down instead of covering any control. */}
          <AppUpdateNotice dependencies={appUpdate} />
          <Outlet />
        </Box>
      </Box>
    </Box>
  )
}
