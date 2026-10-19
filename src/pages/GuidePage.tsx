import { useId, type ReactNode } from 'react'
import { Alert, AlertTitle, Box, Button, Paper, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { PageShell } from '../components/PageShell'
import buildListImage from '../assets/guide/build-list.webp'
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
    height: 500,
    alt: '目標武器画面の一覧。目標武器ごとに有効・優先度、理想ボーナス5枠、理想スキル、妥協条件、優先起点と、「編集」「削除」ボタンが表示されている。',
  },
  search: {
    src: searchImage,
    width: 1040,
    height: 960,
    alt: '候補検索画面。検索対象の目標武器と作成ルートの選択欄、「検索開始」ボタンの下に、検索結果のお知らせと理想候補（完成時の復元ボーナス、スキル、操作回数）が表示されている。',
  },
  buildList: {
    src: buildListImage,
    width: 1040,
    height: 700,
    alt: 'ビルドリスト画面。登録候補数などのページ概要、「生産計画を作成」ボタンと詳細設定、目標武器ごとの候補一覧が表示されている。',
  },
  productionPlan: {
    src: productionPlanImage,
    width: 1040,
    height: 1185,
    alt: '開始前の生産計画画面。「作成開始」ボタン、開始時に変わる優先起点の案内、計画の概要、目標武器ごとの作成ルート、計画全体の実行順の1ステップ目が表示されている。',
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
    height: 543,
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
  { title: '候補を検索する', detail: '目標武器ごとに、理想品までの作成ルートを探します。' },
  { title: 'ビルドリストへ追加する', detail: '生産計画に使いたい候補をまとめます。' },
  { title: '生産計画を作る', detail: '複数の目標武器をまとめた作成順を計算します。' },
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
          作りたい完成武器（巨戟アーティア）の条件を、1つの構成につき1件登録します。同じ武器種・属性でも、欲しい構成が違えば別の目標武器として登録します。
        </Typography>
        <GuideImage image={screenshots.targetWeapons} />
        <BulletList
          items={[
            '名前・武器種・属性・優先度（1〜5、既定は3）を設定します。優先度は、生産計画でどの目標武器を優先するかに使われます。',
            '「有効」がONの目標武器だけが、候補検索と生産計画の対象になります。',
            '理想の復元ボーナス5枠：最終的に欲しい5枠をすべて指定します。並び順は問いません。',
            '理想スキル条件：欲しいシリーズスキル・グループスキルを指定します。',
            '妥協条件（必要な場合だけ）：実用ボーナス条件・代替ボーナス条件・実用スキル条件で、理想品へ向かう途中でも使える状態を指定します。候補検索は妥協条件の有無にかかわらず常に理想品への作成ルートを探し、妥協品を別の候補として探すことはありません。妥協条件を設定すると、そのルートの途中で使える状態も表示され、途中で採用するかを選べます。',
            '優先する所持武器（任意）：この目標を作るときに起点として優先したい所持武器です。より短い作成ルートがある場合は、そちらが選ばれることがあります。',
          ]}
        />
        <Typography>
          すでに理想条件を満たす巨戟アーティアを持っている場合は、目標武器の画面にその旨が表示され、「この武器で目標を完了にする」から完了にできます。
        </Typography>
        <GuideLink to="/target-weapons">目標武器を開く</GuideLink>
      </GuideSection>

      <GuideSection title="3. 候補を検索する">
        <Typography>
          「候補検索」で目標武器を1つ選び、「検索開始」を押します。現在のRNG状態・通常アーティアカウンター・所持武器をもとに、その目標武器の理想品へ到達する作成ルートを探します。
        </Typography>
        <GuideImage image={screenshots.search} />
        <BulletList
          items={[
            '検索中は進捗が表示され、いつでもキャンセルできます。',
            '見つかると理想候補が1件表示され、完成時の復元ボーナスやスキル、操作回数を確認できます。「候補詳細・作成ルート」を開くと、操作ごとの内容を確認できます。',
            '妥協条件を設定している場合は、その理想候補の作成ルートの途中で使える状態が「スキル候補」「復元ボーナス候補」として表示され、途中で採用したい状態を選べます。選ばなくても構いません。',
            '見つからなかった場合は「現在の探索範囲では理想品が見つかりませんでした」と表示されます。「詳細設定（探索量の上限）」で上限を上げると見つかる場合があります。',
            '必要な値が足りずに実行できなかった作成ルートは、理由とともに表示されます。',
          ]}
        />
        <Typography>採用したい候補は「ビルドリストへ追加」を押して追加します。</Typography>
        <GuideLink to="/search">候補検索を開く</GuideLink>
      </GuideSection>

      <GuideSection title="4. ビルドリストへ追加する">
        <Typography>
          ビルドリストは、生産計画に使いたい候補をまとめる場所です。目標武器が複数あっても、それぞれの候補を追加しておけば、生産計画がまとめて作成順を考えます。
        </Typography>
        <GuideImage image={screenshots.buildList} />
        <BulletList
          items={[
            '途中で採用する状態と、理想品までの改善優先は、ビルドリストで変更できます。',
            '目標武器の条件、RNG状態、起点の所持武器などが変わると、その候補は「再検索が必要な候補」になり、生産計画には使われません。候補検索からもう一度追加してください。',
            '追加した候補がすべて生産計画に使われるとは限りません。',
          ]}
        />
        <GuideLink to="/build-list">ビルドリストを開く</GuideLink>
      </GuideSection>

      <GuideSection title="5. 生産計画を作る">
        <Typography>
          ビルドリストの「生産計画を作成」を押すと、登録した候補から生産計画が作られ、計画の画面へ移動します。
        </Typography>
        <GuideImage image={screenshots.productionPlan} />
        <BulletList
          items={[
            '複数の目標武器を1つの計画にまとめられます。スキルや巨戟アーティアの抽選の進み方は目標武器どうしで共有されるため、それを踏まえた作成順が計算されます。',
            '「目標武器ごとの作成ルート」と「計画全体の実行順」で内容を確認してから、「作成開始」を押して実行を始めます。',
            '開始前の計画は下書きとして保存され、「生産計画」の一覧からも開けます。新しく生産計画を作成すると、まだ開始していない下書きは置き換えられます。',
            '途中で採用する状態を選んでいる場合、その状態は理想品へ向かう途中で必ず通る到達点として計画に組み込まれます。到達したときに、その武器を妥協品として確定して終了するか、理想品まで作成を続けるかを選べます。',
            '探索の上限に達して計画を作れなかった場合は、ビルドリストの「詳細設定」で上限を引き上げてから、もう一度作成します。',
          ]}
        />
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
            '最後の操作で理想品が完成すると、その武器は「理想」として保護され、目標武器は完了済みになります。',
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
            「データをエクスポート」を押すと、バックアップデータ（JSON）が表示されます。「コピー」でクリップボードへコピーするか、「ファイル出力」でJSONファイルとして保存します。
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
        <Box component="dl" sx={{ m: 0, display: 'grid', gap: 1.5 }}>
          {[
            ['何をすればよいか分からない', 'ダッシュボードの「次の操作」を確認してください。'],
            ['RNG状態の再特定を求められた', '表示された案内に沿って、RNG状態設定の「RNG状態の特定」、または通常アーティアカウンターで特定し直してください。手動入力だけでは解消されません。'],
            ['候補が「再検索が必要な候補」になった', '候補検索でもう一度検索し、ビルドリストへ追加し直してください。'],
            ['候補が見つからない', '「実行できなかった作成ルート」の理由を確認し、必要なら「詳細設定（探索量の上限）」で上限を上げて検索し直してください。'],
            ['生産計画が「再計算が必要」になった', '生産計画の画面で理由を確認し、「現在地点から再計画を試算」で計画を立て直せます。'],
            ['別の端末で使いたい', '「設定」のエクスポートでバックアップを作り、移行先の端末でインポートしてください。'],
          ].map(([term, description]) => (
            <Box key={term} sx={{ minWidth: 0 }}>
              <Typography component="dt" sx={{ fontWeight: 600 }}>
                {term}
              </Typography>
              <Typography component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                {description}
              </Typography>
            </Box>
          ))}
        </Box>
      </GuideSection>
    </PageShell>
  )
}
