import { useId, type ReactNode } from 'react'
import { Alert, AlertTitle, Box, Button, Link, Paper, Stack, SvgIcon, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { PageShell } from '../components/PageShell'
import buildListImage from '../assets/guide/build-list.webp'
import buildListOptimizationPreviewImage from '../assets/guide/build-list-optimization-preview.webp'
import dashboardImage from '../assets/guide/dashboard.webp'
import executionNavigatorImage from '../assets/guide/execution-navigator.webp'
import executionWeaponSwitchImage from '../assets/guide/execution-weapon-switch.webp'
import productionPlanImage from '../assets/guide/production-plan.webp'
import rngIdentificationImage from '../assets/guide/rng-identification.webp'
import rngSetupImage from '../assets/guide/rng-setup.webp'
import searchImage from '../assets/guide/search.webp'
import settingsBackupImage from '../assets/guide/settings-backup.webp'
import targetWeaponsImage from '../assets/guide/target-weapons.webp'

/*
  User guide (`docs/UI_FLOW.md` 2.2). A user-facing explanation of the
  representative flow, not a specification: every sentence paraphrases the
  formal specifications and the current screens, and none of it is Domain,
  RNG, Search or Planner authority. It reads no persisted data and does not
  depend on Debug Mode.

  The screenshots are real captures of this app, taken with fictional demo
  data (no developer or user data, no Debug values). They are imported so Vite
  resolves them under the GitHub Pages base path.
*/

interface GuideScreenshot {
  src: string
  width: number
  height: number
  alt: string
}

const screenshots = {
  dashboard: {
    src: dashboardImage,
    width: 1280,
    height: 830,
    alt: 'ダッシュボード画面。上部の「次の操作」に「実行中の作成プランがあります」と「実行ナビを再開する」ボタンがあり、その下にRNG状態、利用可能な機能、現在のデータが並んでいる。左側のナビゲーションには「使い方」も表示されている。',
  },
  rngSetup: {
    src: rngSetupImage,
    width: 1040,
    height: 808,
    alt: 'RNG状態設定画面。「保存済みのRNG状態」、「値が分からない場合」の「RNG状態の特定を開始」ボタン、Base Seed・巨戟カウンター・スキルカウンターを入力する「手動入力」欄が表示されている。',
  },
  rngIdentification: {
    src: rngIdentificationImage,
    width: 900,
    height: 706,
    alt: '「RNG状態の特定」ダイアログのSTEP 1。STEP 1・STEP 2・確認・採用の進行表示、開始前に確認する注意事項、スキル抽選結果を記録する入力欄が表示されている。',
  },
  targetWeapons: {
    src: targetWeaponsImage,
    width: 1040,
    height: 590,
    alt: '目標武器画面の一覧。「大剣 火属性（攻撃型）」に「完成ボーナス構成 2件（いずれかを満たせば完成）」として完成構成1と完成構成2が並び、各枠は「基礎攻撃力強化EX」「会心率強化II以上」のように種類と最低ランクで表示され、その下に完成スキルが表示されている。',
  },
  search: {
    src: searchImage,
    width: 1040,
    height: 1290,
    alt: '候補検索画面。検索対象の目標武器の選択欄の下に「検索開始」「未登録を一括検索・追加（0件）」「再検索が必要な候補を一括再検索・置換（3件）」ボタンがあり、検索結果に完成時の復元ボーナス、スキル、達成した完成構成、操作回数と「ビルドリストへ追加」ボタンを持つ候補が1件表示されている。',
  },
  buildList: {
    src: buildListImage,
    width: 1040,
    height: 1068,
    alt: 'ビルドリスト画面。ページ概要の下の「生産計画の作成」に、有効な候補が3件あるため作成ルートを組み直して試算することと、採用するまで変更されないことの説明、「生産計画を作成」ボタン、「詳細設定（通常Planner用）」があり、その下に目標武器ごとの候補一覧が表示されている。',
  },
  buildListOptimizationPreview: {
    src: buildListOptimizationPreviewImage,
    width: 1040,
    height: 836,
    alt: '「全体最適化の試算（未採用）」の表示。「まだ作成リストと生産計画は変更されていません」という案内の下に、完成予定の目標武器 3 / 3、対象外の目標武器、競合なし、ゲーム内の操作回数、計画ステップ数、置き換わる候補の数が並び、画面下部に「この計画を採用」と「戻る」ボタンが表示されている。',
  },
  productionPlan: {
    src: productionPlanImage,
    width: 1040,
    height: 932,
    alt: '保存された開始前の生産計画画面。「作成開始」ボタン、下書きであることを示す計画の概要（全ステップ数、完成予定の目標武器数など）、計画全体の実行順の1ステップ目が表示されている。',
  },
  executionNavigator: {
    src: executionNavigatorImage,
    width: 780,
    height: 1688,
    alt: 'スマートフォン幅の実行ナビゲーション画面。Step 2 / 5 の「巨戟アーティアへ変換」の操作、使用する武器、想定結果のスキル、「結果一致・次へ」「結果が違う」「何を何回操作したか分からない」ボタンが表示されている。',
  },
  executionWeaponSwitch: {
    src: executionWeaponSwitchImage,
    width: 780,
    height: 1688,
    alt: 'スマートフォン幅の実行ナビゲーション画面の武器切替案内。目標武器の完成通知の下に「作業する武器を切り替えてください」と「武器を切り替えました」ボタン、その下にゲーム内セーブ地点の記録とUndoがある実行状態の管理が表示されている。',
  },
  settingsBackup: {
    src: settingsBackupImage,
    width: 992,
    height: 511,
    alt: '設定画面の「データ管理」。バックアップの「データをエクスポート」、復元の「データをインポート」、初期化の「全データを削除」ボタンが表示されている。',
  },
} satisfies Record<string, GuideScreenshot>

interface GuideImageProps {
  image: GuideScreenshot
  /** Below-the-fold images load lazily; only the first image loads eagerly. */
  eager?: boolean
  /** Caps the displayed width, e.g. for smartphone captures. */
  maxWidth?: number
}

/**
 * One screenshot. The explicit width / height keep the aspect ratio reserved
 * before the image loads; CSS scales it down to the available width so it
 * never causes horizontal overflow. The alt text is the only text alternative:
 * no visible caption repeats it, so the accessibility tree holds it once.
 */
function GuideImage({ image, eager = false, maxWidth }: GuideImageProps) {
  return (
    <Box
      component="img"
      src={image.src}
      width={image.width}
      height={image.height}
      alt={image.alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      sx={{
        display: 'block',
        width: '100%',
        maxWidth: maxWidth ?? '100%',
        height: 'auto',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.default',
      }}
    />
  )
}

function GuideLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Box>
      <Button component={RouterLink} to={to} variant="outlined" sx={{ minHeight: 44 }}>
        {children}
      </Button>
    </Box>
  )
}

/**
 * Issue #363: the public repository's Issues, so a user who only knows the
 * GitHub Pages URL can report a problem. Never the private development
 * repository.
 */
const publicIssuesUrl = 'https://github.com/nekono-lazy/GogmaPlanner/issues'

/** Read by a screen reader, never shown (the usual visually hidden pattern). */
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  p: 0,
  m: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const

/** Marks a link that leaves the app; the link's own text says so to a screen reader. */
function ExternalLinkIcon() {
  return (
    <SvgIcon aria-hidden="true" sx={{ fontSize: '1em', ml: 0.25, verticalAlign: '-0.125em' }}>
      <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z" />
    </SvgIcon>
  )
}

/**
 * External link opened in a new tab. `noopener noreferrer` keeps the opened
 * page from reaching this window; the icon and the hidden text tell sighted
 * and screen reader users that it leaves the app. `nowrap` keeps the icon on
 * the line of the text it marks.
 */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer" sx={{ whiteSpace: 'nowrap' }}>
      {children}
      <ExternalLinkIcon />
      <Box component="span" sx={visuallyHidden}>
        （外部サイトを新しいタブで開きます）
      </Box>
    </Link>
  )
}

function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
      {items.map((item, index) => (
        <Typography component="li" key={index} sx={{ overflowWrap: 'anywhere' }}>
          {item}
        </Typography>
      ))}
    </Box>
  )
}

/** Steps the user takes in this order: a real ordered list, so assistive technology reads the step numbers. */
function NumberedList({ label, items }: { label: string; items: ReactNode[] }) {
  return (
    <Box component="ol" aria-label={label} sx={{ m: 0, pl: 3, display: 'grid', gap: 0.75 }}>
      {items.map((item, index) => (
        <Typography component="li" key={index} sx={{ overflowWrap: 'anywhere' }}>
          {item}
        </Typography>
      ))}
    </Box>
  )
}

/** Term / explanation pairs, stacked so long Japanese terms wrap at any width instead of forcing a table to scroll. */
function DefinitionList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gap: 1.5 }}>
      {items.map(([term, description]) => (
        <Box key={term} sx={{ minWidth: 0 }}>
          <Typography component="dt" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {term}
          </Typography>
          <Typography component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>
            {description}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}

function GuideSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 3 }, minWidth: 0 }}
    >
      <Stack spacing={2}>
        <Typography id={headingId} component="h2" variant="h2">
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  )
}

function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack component="section" spacing={1.5} sx={{ minWidth: 0 }}>
      <Typography component="h3" variant="h3">
        {title}
      </Typography>
      {children}
    </Stack>
  )
}

const basicFlow = [
  { title: 'RNG状態を準備する', detail: '予測に使うBase Seedと各カウンターを設定します。' },
  { title: '目標武器を登録する', detail: '作りたい完成武器の条件を登録します。' },
  { title: '候補を検索する', detail: '目標武器ごとに、完成条件を満たす作成ルートを探します。' },
  { title: 'ビルドリストへ追加する', detail: '生産計画で作る目標武器の候補をまとめます。' },
  { title: '生産計画を作る', detail: '作成ルートと作成順を計算し、内容を確認してから保存します。' },
  { title: '実行ナビで作成する', detail: 'ゲーム内の操作を1つずつ確認しながら進めます。' },
]

export function GuidePage() {
  return (
    <PageShell
      title="使い方"
      description="Gogma Artian Plannerで目標武器を探し、生産計画をゲーム内で実行するまでの流れを説明します。"
    >
      <GuideSection title="基本の流れ">
        <Typography>
          代表的な使い方は次の順番です。すでに持っている武器や、使いたい作成ルートによって必要な準備は変わります。
        </Typography>
        <Box
          component="ol"
          sx={{
            m: 0,
            p: 0,
            listStyle: 'none',
            display: 'grid',
            gap: 1,
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' },
          }}
        >
          {basicFlow.map((step, index) => (
            <Box
              component="li"
              key={step.title}
              sx={{
                display: 'flex',
                gap: 1.5,
                alignItems: 'flex-start',
                p: 1.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                minWidth: 0,
              }}
            >
              <Box
                sx={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                }}
              >
                {index + 1}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>{step.title}</Typography>
                <Typography variant="body2" color="textSecondary">
                  {step.detail}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
        <Typography>
          何をすればよいか迷ったときは、ダッシュボードの「次の操作」に、いま進めるとよい操作が表示されます。
        </Typography>
        <GuideImage image={screenshots.dashboard} eager />
      </GuideSection>

      <GuideSection title="まず知っておくこと">
        <BulletList
          items={[
            '入力したデータは、このブラウザの中（IndexedDB）に保存されます。ユーザーアカウントやクラウド同期はありません。',
            'PCとスマートフォンのどちらのブラウザでも、主要な機能をすべて使えます。',
            '保存されたデータは端末・ブラウザごとに別々です。端末を変えるときは、「設定」のエクスポートとインポートでデータを移してください。',
            '管理できるのは1キャラクター分のデータです。別のキャラクターで使うときは、現在のデータをエクスポートしてバックアップしてから、データを切り替えてください。',
          ]}
        />
      </GuideSection>

      <GuideSection title="1. RNG状態を準備する">
        <Typography>
          候補検索と生産計画は、ゲーム内の抽選の位置（RNG状態）をもとに結果を予測します。「RNG状態設定」で、Base Seed（基準シード）・巨戟カウンター・スキルカウンターを設定します。
        </Typography>
        <GuideImage image={screenshots.rngSetup} />
        <SubSection title="値が分かっている場合">
          <Typography>
            「手動入力」に分かっている値を入力し、正しいと確認できた値は「この値を検索・予測に使用する」を選んで保存します。3つすべてを入力する必要はありません。
          </Typography>
        </SubSection>
        <SubSection title="値が分からない場合">
          <Typography>
            「値が分からない場合」の「RNG状態の特定を開始」から、ゲーム内で続けて行ったスキルの抽選結果（STEP 1）と復元ボーナスのリセット結果（STEP 2）を記録して、値を特定します。何をどの順番で記録するかは、画面の案内に沿って進めてください。
          </Typography>
          <GuideImage image={screenshots.rngIdentification} />
          <Alert severity="warning">
            <AlertTitle>特定するときの注意</AlertTitle>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              <li>観測結果の記録が終わるまで、ゲーム状態を保存しないでください。</li>
              <li>開始前に、セーブデータのバックアップ方法と自動保存の設定・挙動を確認してください。</li>
              <li>観測後は、ゲームを調査前の状態へ戻してから結果を採用します。</li>
              <li>ゲーム側の保存仕様やセーブデータの安全を、このアプリが保証するものではありません。</li>
            </Box>
          </Alert>
        </SubSection>
        <Typography>
          必要な値は、使う作成ルートによって変わります。スキルの予測にはスキルカウンター、巨戟アーティアの復元ボーナスの予測には巨戟カウンターを使い、どちらにもBase Seedが必要です。いま何が使えるかは、画面下の「現在の入力内容で利用可能な機能」で確認できます。
        </Typography>
        <Typography>
          なお、ビルドリストに有効な候補が2件以上あるときに使われる全体最適化（「5. 生産計画を作る」）では、Base Seed・巨戟カウンター・スキルカウンターの3つすべての確定が必要です。
        </Typography>
        <GuideLink to="/rng">RNG状態設定を開く</GuideLink>
      </GuideSection>

      <GuideSection title="必要な場合だけ行う準備">
        <Typography>
          次の2つは、すべての人に必須の手順ではありません。使いたい作成ルートに合わせて行ってください。
        </Typography>
        <SubSection title="通常アーティアカウンター">
          <Typography>
            新しく作る通常アーティアの復元ボーナスまで予測する作成ルートを使いたい場合は、その武器種の通常アーティアカウンターを確定します。「通常アーティアカウンター」画面で、同じ武器種の通常アーティアを続けて作成した結果を入力して検索します。
          </Typography>
          <BulletList
            items={[
              '14武器種すべてを先に設定する必要はありません。使いたい武器種だけで十分です。',
              '未確定のままでも、スキルの予測、巨戟アーティアの復元ボーナスの予測、所持している巨戟アーティアや通常アーティアから始める作成ルートは使えます。',
              'ただし全体最適化（有効な候補が2件以上のときの生産計画の作成）では、起点にできる所持武器が無い目標武器について、その武器種の通常アーティアカウンターの確定が必要です。',
              '新しく作る通常アーティアでも、作成直後の復元ボーナスを予測せず、巨戟化してから復元ボーナスを再抽選するルートなら検索できる場合があります。その場合は候補検索の「お知らせ」に表示されます。',
              '観測のあとはゲームを保存せず、調査前の状態へ戻ったことを確認してからカウンターを確定してください。',
            ]}
          />
          <GuideLink to="/normal-counters">通常アーティアカウンターを開く</GuideLink>
        </SubSection>
        <SubSection title="所持武器">
          <Typography>
            すでに持っている通常アーティアや巨戟アーティアを作成の起点に使いたい場合は、「所持武器」に1本ずつ登録します。登録した武器から始まる作成ルートも候補検索の対象になります。起点に使いたい武器がなければ、登録しなくても使えます。
          </Typography>
          <BulletList
            items={[
              '巨戟アーティアは、復元ボーナスの種類（通常アーティア系／巨戟アーティア系）とシリーズスキル・グループスキルも登録します。巨戟化した直後で、まだ復元ボーナスを変更していない場合は「通常アーティア系」です。',
              '「保護」をONにした武器は、復元ボーナスやスキルを変更する作成ルートには使われません。現在の性能のまま目標を満たす場合だけ候補になります。',
              '状態（未分類／実用／理想）は整理用のラベルで、どの作成ルートを使うかには影響しません。',
            ]}
          />
          <GuideLink to="/owned-weapons">所持武器を開く</GuideLink>
        </SubSection>
      </GuideSection>

      <GuideSection title="2. 目標武器を登録する">
        <Typography>
          作りたい完成武器（巨戟アーティア）の条件を登録します。目標武器1件は、作りたい完成武器1本を表します。
        </Typography>
        <Typography>
          完成として受け入れてよい復元ボーナスの組み合わせが複数ある場合も、目標武器は1件のままで、その中に完成ボーナス構成を追加します。構成ごとに別の目標武器を作る必要はありません。反対に、同じ条件の武器を2本作りたい場合は、目標武器を2件登録します。
        </Typography>
        <GuideImage image={screenshots.targetWeapons} />
        <BulletList
          items={[
            '名前・武器種・属性・優先度（1〜5、既定は3）を設定します。優先度は、生産計画でどの目標武器を優先するかに使われます。',
            '「有効」がONの目標武器だけが、候補検索と生産計画の対象になります。',
            '完成ボーナス構成：完成として受け入れる復元ボーナス5枠を、枠ごとに種類と最低ランクで指定します。各枠は、種類が一致し、ランクが最低ランク以上なら満たします（例：「III以上」の枠は同じ種類のEXでも満たします）。最高ランクのEXを指定した枠は「EX」と表示されます。枠の並び順は問いません。',
            '完成ボーナス構成は「新しい構成を追加」で増やせます。一部の枠だけが異なる構成は、元にする構成の「この構成を複製」から作ると便利です。構成どうしに優先順位はなく、どれか1つの構成を満たせばボーナスの条件を満たします。',
            '完成スキル条件：欲しいシリーズスキル・グループスキルを指定します。指定したスキルはすべて一致する必要があります。目標武器は、いずれかの完成ボーナス構成と完成スキル条件の両方を満たしたときに完成です。',
            '優先する所持武器（任意）：この目標を作るときに起点として優先したい所持武器です。より短い作成ルートがある場合や、全体最適化で別の起点が選ばれた場合は、その起点で作ります。',
            '完成条件の再設定が必要な目標武器：旧バージョンのデータを移行した目標武器には「完成条件の再設定が必要」と表示されます。「編集」で内容を確認して保存するまで、候補検索や生産計画の対象になりません。一覧の「完成条件の再設定が必要な目標武器だけ表示」で絞り込めます。',
            '他の目標武器と完成条件が重なる場合は、保存の前に確認が表示されます。それぞれ別の武器として作るなら「別の1本として登録する」（編集のときは「別の1本として保存する」）を選びます。',
          ]}
        />
        <Typography>
          すでに完成条件を満たす巨戟アーティアを持っている場合は、目標武器の画面にその旨が表示され、「この武器で目標を完了にする」から完了にできます。1本の武器で完了にできる目標武器は1件だけです。
        </Typography>
        <GuideLink to="/target-weapons">目標武器を開く</GuideLink>
      </GuideSection>

      <GuideSection title="3. 候補を検索する">
        <Typography>
          「候補検索」で目標武器を1つ選び、「検索開始」を押します。現在のRNG状態・通常アーティアカウンター・所持武器をもとに、その目標武器の完成条件を満たす作成ルートを探します。完成ボーナス構成が複数ある目標武器では、どの構成を満たすルートも同じように探します。
        </Typography>
        <GuideImage image={screenshots.search} />
        <BulletList
          items={[
            '検索中は進捗が表示され、いつでもキャンセルできます。',
            '見つかると、完成条件を満たす候補が1件表示されます。完成時の復元ボーナスとスキル、満たしている完成構成（「達成した完成構成」）、操作回数を確認できます。「候補詳細・作成ルート」を開くと、操作ごとの内容を確認できます。',
            '見つからなかった場合は「現在の探索範囲では完成条件を満たす候補が見つかりませんでした」と表示されます。「詳細設定（探索量の上限）」で上限を上げると見つかる場合があります。',
            '必要な値が足りずに実行できなかった作成ルートは、理由とともに表示されます。',
          ]}
        />
        <Typography>使いたい候補は「ビルドリストへ追加」を押して追加します。</Typography>
        <SubSection title="まとめて検索する">
          <DefinitionList
            items={[
              [
                '未登録を一括検索・追加',
                'ビルドリストに候補がまだ無い目標武器を1件ずつ順に検索し、見つかった候補をビルドリストへ追加します。',
              ],
              [
                '再検索が必要な候補を一括再検索・置換',
                'ビルドリストで「再検索が必要」になっている候補の目標武器を1件ずつ順に検索し直します。完成条件を満たす候補が見つかった目標武器だけ、候補を新しい候補へ置き換えます。見つからなかった目標武器や、検索に失敗した目標武器の候補はそのまま残ります。',
              ],
            ]}
          />
          <Typography>
            再検索が必要な候補でも、完了済みや「有効」がOFFの目標武器の候補、同じ目標武器に候補が複数ある場合、実行中の生産計画が使っている候補などは、一括再検索・置換の対象外です。対象外の候補はボタンの件数に含まれず、理由とともに一覧で確認できます。対象の候補もすべてが置き換わるとは限らず、結果は目標武器ごとに表示されます。
          </Typography>
        </SubSection>
        <GuideLink to="/search">候補検索を開く</GuideLink>
      </GuideSection>

      <GuideSection title="4. ビルドリストへ追加する">
        <Typography>
          ビルドリストは、生産計画で作る目標武器の候補をまとめる場所です。画面の中では「作成リスト」とも表記されます。目標武器ごとに候補を1件だけ登録でき、有効な候補がある目標武器が、生産計画の対象になります（再検索が必要な候補や、完了済み・「有効」がOFFの目標武器の候補は対象になりません）。
        </Typography>
        <GuideImage image={screenshots.buildList} />
        <BulletList
          items={[
            'すでに候補がある目標武器へ別の候補を追加しようとすると、候補を置き換えるかどうかの確認が表示されます。',
            '有効な候補が2件以上あるときの生産計画の作成（全体最適化）では、登録した候補の作成ルートがそのまま使われるとは限りません。ビルドリストの目標武器全体について、作成ルートが組み直されます（「5. 生産計画を作る」）。',
            '目標武器の完成条件、RNG状態、起点の所持武器などが変わると、その候補は「再検索が必要」になり、そのままでは生産計画に使われません。候補検索の「再検索が必要な候補を一括再検索・置換」でまとめて検索し直すか、1件ずつ検索し直して「ビルドリストへ追加」から置き換えてください。',
            '実行中の生産計画で使っている候補が、計画どおりに進めたことで古くなった場合は「実行中の生産計画で使用中」と表示されます。その生産計画はそのまま続けられます。',
          ]}
        />
        <GuideLink to="/build-list">ビルドリストを開く</GuideLink>
      </GuideSection>

      <GuideSection title="5. 生産計画を作る">
        <Typography>
          ビルドリストの「生産計画の作成」にある「生産計画を作成」を押します。スキルや巨戟アーティアの抽選の進み方は目標武器どうしで共有されるため、複数の目標武器を1つの計画にまとめ、それを踏まえた作成順を計算します。
        </Typography>
        <SubSection title="作成方法は有効な候補の数で決まります">
          <Typography>
            ボタンは1つだけで、どちらの方法で作るかはアプリが判定し、ボタンの近くに表示します。
          </Typography>
          <DefinitionList
            items={[
              [
                '有効な候補が1件',
                '登録した候補の作成ルートをそのまま使って生産計画を作ります（通常Planner）。作成に成功すると、保存された生産計画の画面へ移動します。',
              ],
              [
                '有効な候補が2件以上',
                '全体最適化で、ビルドリストの目標武器全体について作成ルートと作成順を計算し直します。結果は、まず未採用の試算として表示されます（下の「試算を確認して採用する」）。',
              ],
              ['有効な候補が0件', '生産計画は作れません。候補検索で候補を追加してください。'],
            ]}
          />
          <BulletList
            items={[
              '件数は、画面に並んでいる候補の数ではなく、そのまま計画に使える候補の数です。再検索が必要な候補や、完了済みの目標武器の候補は数えません。',
              '武器種・属性の絞り込みで画面から隠れている候補も、生産計画の対象に含まれます。',
              '同じ目標武器に候補が複数あるなど、ビルドリストに整理が必要な項目がある場合は、生産計画の作成を開始できません。理由はボタンの近くに表示されます。',
              '実行中の生産計画がある間は「生産計画を作成」は表示されず、代わりに「現在地点からの再計画」が表示されます（下の「実行中の生産計画があるとき」）。',
            ]}
          />
        </SubSection>
        <SubSection title="全体最適化について">
          <Typography>
            全体最適化は、ビルドリストに登録した目標武器全体について作成ルートを組み直し、まとめて作れる生産計画を探す機能です。登録した候補のルートを並べ替えるだけではなく、別の作成ルートや別の起点の武器を選ぶことがあります。
          </Typography>
          <BulletList
            items={[
              '最短の計画になること、計算が必ず成功すること、すべての目標武器を完成させる計画が見つかることは保証しません。',
              '計算中は現在の段階と「キャンセル」が表示されます。画面を閉じたり別の画面へ移動したりすると、計算は中止されます。',
              '計算に時間がかかる場合は、その旨が表示されます。処理は続いているので、待つか「キャンセル」を押してください。',
            ]}
          />
        </SubSection>
        <SubSection title="試算を確認して採用する">
          <Typography>全体最適化の計算が成功したら、次の順に進めます。</Typography>
          <NumberedList
            label="全体最適化の試算を採用する手順"
            items={[
              '「全体最適化の試算（未採用）」が表示されます。この時点では、ビルドリストも生産計画も変更されていません。',
              '完成予定の目標武器の数、対象外の目標武器、競合の有無、ゲーム内の操作回数、置き換わる候補、計画全体の実行順、必要素材・費用の目安を確認します。',
              'この試算を使う場合は、試算の下部にある「この計画を採用」を押します。使わない場合は「戻る」を押します。',
              '採用確認（「この計画を採用しますか？」）で、置き換える候補の件数や下書きの扱いを確認し、もう一度「この計画を採用」を押します。',
              'ビルドリストの対象の候補が試算の候補へまとめて置き換わり、生産計画が下書きとして保存されます。そのまま保存した生産計画の画面へ移動します。',
            ]}
          />
          <GuideImage image={screenshots.buildListOptimizationPreview} />
          <Alert severity="info">
            <AlertTitle>試算を表示しただけでは保存されません</AlertTitle>
            ビルドリストと生産計画が変わるのは、採用確認で「この計画を採用」を押して採用が成功したときだけです。「戻る」を押したり画面を離れたりすると試算は破棄され、ビルドリストと生産計画はそのまま残ります。
          </Alert>
          <Alert severity="warning">
            <AlertTitle>採用するときの注意</AlertTitle>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              <li>試算全体をまとめて採用します。目標武器ごとに一部だけ採用することはできません。</li>
              <li>置き換えた前の候補は、自動では元に戻りません。元の候補を使いたい場合は、候補検索で検索し直してビルドリストへ追加してください。</li>
              <li>まだ開始していない生産計画（下書き）がある場合は、採用した計画に置き換わります。</li>
              <li>試算のあとでビルドリストや所持武器などが変わっていた場合は採用できず、試算は破棄されます。もう一度「生産計画を作成」を押して計算してください。</li>
            </Box>
          </Alert>
          <BulletList
            items={[
              '「完成予定の目標武器」は、今回の計画の対象になった目標武器のうち、完成する予定の数です。候補が無い、再検索が必要などで対象外になった目標武器は含まれず、「対象外の目標武器」に分けて表示されます。',
              '「ゲーム内の操作回数」はゲーム内で実際に行う操作の回数です。「計画ステップ数」には、所持武器が完成条件を満たしていることを確認するだけのステップも含まれるため、操作回数と一致しないことがあります。',
            ]}
          />
        </SubSection>
        <SubSection title="全体最適化で計画を作れなかったとき">
          <Typography>
            「組み合わせを見つけられませんでした」「結果を確定できませんでした」「この作成リストでは全体最適化を使えません」などの結果と理由が表示されます。どの場合も、ビルドリストと生産計画は変更されていません。
          </Typography>
          <Typography>
            全体最適化を使えないことが押す前から分かっている場合は、「生産計画を作成」は押せず、ボタンの近くに理由が表示されます。主な理由は、RNG状態の一部が確定していないことと、起点にできる所持武器も確定した通常アーティアカウンターも無い目標武器があることです。
          </Typography>
          <Typography>
            結果や理由によっては、その表示の中に「登録済みの候補で生産計画を作成」が表示されます。ビルドリストに登録した候補の作成ルートをそのまま使う、通常Plannerでの作成です。
          </Typography>
          <BulletList
            items={[
              '全体最適化から通常Plannerへ自動では切り替わりません。使う場合は、表示されたボタンを自分で押します。',
              'このボタンは常に表示されるわけではなく、通常Plannerで作成できる場合だけ表示されます。',
              '通常Plannerは作成ルートを組み直さず、ビルドリストの候補も変更しません。すべての目標武器が完成すること、競合が無いことは保証しません。',
              '作成に成功すると、生産計画の画面へ移動します。まだ開始していない下書きがある場合は置き換わります。',
            ]}
          />
        </SubSection>
        <SubSection title="詳細設定（通常Planner用）">
          <Typography>
            ビルドリストの「詳細設定（通常Planner用）」にある「最大計画ステップ数」は、通常Plannerで作るとき（有効な候補が1件のときの「生産計画を作成」と「登録済みの候補で生産計画を作成」など）の安全上限です。全体最適化には使われず、全体最適化の探索の上限はこの設定では変わりません。通常Plannerで上限に達して計画が完成しなかった場合は、この値を増やしてもう一度作成します。
          </Typography>
        </SubSection>
        <SubSection title="作成した生産計画を確認して開始する">
          <GuideImage image={screenshots.productionPlan} />
          <BulletList
            items={[
              '保存した生産計画は「下書き」として「生産計画」の一覧から開けます。「目標武器ごとの作成ルート」と「計画全体の実行順」で内容を確認してから、「作成開始」を押して実行を始めます。',
              '新しく生産計画を保存すると（全体最適化では試算を採用すると）、まだ開始していない下書きは置き換えられます。',
            ]}
          />
        </SubSection>
        <SubSection title="実行中の生産計画があるとき">
          <Typography>
            実行中（または「再計算が必要」）の生産計画がある間は、新しい生産計画は作成できません。作る目標武器を見直す場合は、ビルドリストや生産計画の画面の「現在地点からの再計画」で、いまの進み具合から計画を立て直せます。再計画も、試算を確認してから採用します。
          </Typography>
        </SubSection>
        <GuideLink to="/plans">生産計画の一覧を開く</GuideLink>
      </GuideSection>

      <GuideSection title="6. 実行ナビで作成する">
        <Typography>
          実行ナビは、ゲーム内で行う操作を1つずつ案内する画面です。PCやPS5でゲームを操作しながら、スマートフォンで実行ナビを確認する使い方も想定しています。
        </Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { xs: 'center', sm: 'flex-start' }, justifyContent: 'center' }}
        >
          <GuideImage image={screenshots.executionNavigator} maxWidth={300} />
          <GuideImage image={screenshots.executionWeaponSwitch} maxWidth={300} />
        </Stack>
        <BulletList
          items={[
            '案内された操作をゲーム内で1回行い、結果が「想定結果」と同じなら「結果一致・次へ」を押します。1操作ごとに進行が保存されるので、途中でブラウザを閉じても、ダッシュボードの「実行ナビを再開する」から続けられます。',
            '復元ボーナスを予測していない通常アーティアを作るステップでは、ゲーム画面で確認した実際の5枠を入力して確定します。',
            '作業する武器が変わるときは、切り替え先の武器が案内されます。ゲーム内で武器を切り替えたら「武器を切り替えました」を押します。',
            '最後の操作で目標武器の完成条件を満たす武器ができると、その武器は状態「理想」として保護され、目標武器は完了済みになります。',
          ]}
        />
        <SubSection title="思いどおりに進まなかったとき">
          <BulletList
            items={[
              '結果が想定結果と違った：「結果が違う」で実際の結果を記録します。計画は止まり、RNG状態の再特定が案内されます。',
              '何を何回操作したか分からなくなった：「何を何回操作したか分からない」を記録し、画面の案内に沿って現在位置の確認やゲーム内セーブ地点への復元を行います。',
              '間違えて確定した：「最後の操作をUndo」で、アプリ上の記録だけを取り消せます。ゲーム内の操作は戻りません。',
              'ゲーム内でセーブした：「ゲーム内セーブ済みとして記録」を押しておくと、あとでその地点までアプリの状態を戻せます。アプリはゲームのセーブを自動では判別しません。',
            ]}
          />
        </SubSection>
      </GuideSection>

      <GuideSection title="バックアップと復元">
        <Typography>
          データのバックアップと復元は「設定」の「データ管理」で行います。実行中の生産計画や作成の進行状況もバックアップに含まれます。
        </Typography>
        <GuideImage image={screenshots.settingsBackup} />
        <SubSection title="バックアップ（エクスポート）">
          <Typography>
            「データをエクスポート」を押すと、作成したバックアップの概要（作成日時、データ量、主な件数）が表示されます。「ファイルに保存」でJSONファイルとして保存してください。クリップボードへコピーしたいときは「コピー」を使います。
          </Typography>
        </SubSection>
        <SubSection title="復元（インポート）">
          <Typography>
            「データをインポート」を押し、バックアップのJSONを貼り付けて「貼り付けた内容を読み込む」を押すか、「ファイルから読み込む」でJSONファイルを選びます。内容を確認したうえで「現在のデータを置き換えてインポート」を押すと復元されます。
          </Typography>
          <Alert severity="warning">
            インポートは全置換です。現在保存されているデータは、すべてバックアップの内容に置き換わります。必要な場合は、先に現在のデータをエクスポートしてください。
          </Alert>
        </SubSection>
        <GuideLink to="/settings">設定を開く</GuideLink>
      </GuideSection>

      <GuideSection title="困ったとき">
        <DefinitionList
          items={[
            ['何をすればよいか分からない', 'ダッシュボードの「次の操作」を確認してください。'],
            ['RNG状態の再特定を求められた', '表示された案内に沿って、RNG状態設定の「RNG状態の特定」、または通常アーティアカウンターで特定し直してください。手動入力だけでは解消されません。'],
            ['候補が「再検索が必要」になった', '候補検索の「再検索が必要な候補を一括再検索・置換」でまとめて検索し直すか、1件ずつ検索し直してビルドリストへ追加してください。'],
            ['候補が見つからない', '「実行できなかった作成ルート」の理由を確認し、必要なら「詳細設定（探索量の上限）」で上限を上げて検索し直してください。'],
            ['全体最適化で生産計画を作れなかった', '表示された理由を確認してください。「登録済みの候補で生産計画を作成」が表示されている場合は、登録済みの候補の作成ルートのまま、通常Plannerで生産計画を作れます。'],
            ['採用した後で、置き換わる前の候補に戻したい', '置き換えた候補は自動では戻りません。候補検索で検索し直して、ビルドリストへ追加してください。'],
            ['生産計画が「再計算が必要」になった', '生産計画の画面で理由を確認し、「現在地点からの再計画」で計画を立て直せます。'],
            ['別の端末で使いたい', '「設定」のエクスポートでバックアップを作り、移行先の端末でインポートしてください。'],
          ]}
        />
      </GuideSection>

      <Typography color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        不具合や使いにくい点などがあれば、<ExternalLink href={publicIssuesUrl}>GitHub Issue</ExternalLink>でお知らせください。
      </Typography>
    </PageShell>
  )
}
