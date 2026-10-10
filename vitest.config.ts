// 部品を単独で試すときの設定（Monosashi の中ではリポジトリの vitest.config.ts が使われる）
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['__tests__/**/*.test.ts'] },
})
