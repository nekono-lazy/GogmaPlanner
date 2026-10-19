import { Box, Button, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { PageShell } from '../components/PageShell'

export function NotFoundPage() {
  return (
    <PageShell
      title="ページが見つかりません"
      description="指定されたアドレスに対応する画面はありません。"
    >
      <Box>
        <Typography sx={{ mb: 2 }}>
          アドレスが正しいか確認するか、ダッシュボードから目的の画面へ移動してください。
        </Typography>
        <Button component={RouterLink} to="/" variant="contained" sx={{ minHeight: 44 }}>
          ダッシュボードへ戻る
        </Button>
      </Box>
    </PageShell>
  )
}
