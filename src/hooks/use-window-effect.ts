import { useEffect } from 'react'
import { usePreferences } from '@/services/preferences'
import { isNativeApp } from '@/lib/environment'
import type { WindowEffect } from '@/types/preferences'

async function applyWindowEffect(effect: WindowEffect) {
  if (!isNativeApp()) return
  try {
    const mod = await import('@tauri-apps/api/window')
    await mod.getCurrentWindow().setEffects({
      effects: [
        effect as unknown as (typeof mod.Effect)[keyof typeof mod.Effect],
      ],
      radius: 12,
      state: mod.EffectState.Active,
    })
  } catch (error) {
    console.error('Failed to set window effect:', error)
  }
}

export function useWindowEffect() {
  const { data: preferences } = usePreferences()

  useEffect(() => {
    const effect = preferences?.window_effect ?? 'sidebar'
    applyWindowEffect(effect)
  }, [preferences?.window_effect])
}
