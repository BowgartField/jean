import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProjects, useUpdateProjectSettings } from '@/services/projects'
import type { ProjectAutoFixSettings } from '@/types/projects'
import { codexDefaultModelOptions, modelOptions } from '@/types/preferences'
import {
  CURSOR_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'

export const MR_ROBOT_SETTINGS_BADGE = 'Beta'

const DEFAULT_AUTO_FIX_SETTINGS: ProjectAutoFixSettings = {
  enabled: false,
  interval_minutes: 30,
  issue_limit: 1,
  max_parallel_worktrees: 1,
  planning_backend: 'claude',
  planning_model: null,
  auto_yolo_enabled: false,
  yolo_backend: 'claude',
  yolo_model: null,
  active_hours_enabled: false,
  active_hours_start: 20,
  active_hours_end: 8,
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour)

function formatHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}:00 ${period}`
}

function Field({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
      {children}
    </div>
  )
}

function getModelOptions(backend: string) {
  switch (backend) {
    case 'codex':
      return codexDefaultModelOptions
    case 'opencode':
      return OPENCODE_MODEL_OPTIONS
    case 'cursor':
      return CURSOR_MODEL_OPTIONS
    case 'claude':
    default:
      return modelOptions
  }
}

function ModelSelect({
  backend,
  value,
  disabled,
  onChange,
}: {
  backend: string
  value: string | null | undefined
  disabled?: boolean
  onChange: (value: string | null) => void
}) {
  const options = getModelOptions(backend)

  return (
    <Select
      value={value ?? 'default'}
      disabled={disabled}
      onValueChange={v => onChange(v === 'default' ? null : v)}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Backend default</SelectItem>
        {options.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function AutoFixPane({ projectId }: { projectId: string }) {
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === projectId)
  const updateSettings = useUpdateProjectSettings()

  const initialSettings = useMemo(
    () => ({
      ...DEFAULT_AUTO_FIX_SETTINGS,
      ...(project?.auto_fix_settings ?? {}),
    }),
    [project?.auto_fix_settings]
  )
  const [settings, setSettings] =
    useState<ProjectAutoFixSettings>(initialSettings)

  useEffect(() => {
    setSettings(initialSettings)
  }, [initialSettings])

  const setNumber = (
    key: 'interval_minutes' | 'issue_limit' | 'max_parallel_worktrees',
    value: string
  ) => {
    const parsed = Number.parseInt(value, 10)
    setSettings(current => ({
      ...current,
      [key]: Number.isFinite(parsed) ? Math.max(1, parsed) : 1,
    }))
  }

  const saveSettings = (nextSettings = settings) => {
    updateSettings.mutate({
      projectId,
      autoFixSettings: {
        ...nextSettings,
        planning_model: nextSettings.planning_model?.trim() || null,
        yolo_model: nextSettings.yolo_model?.trim() || null,
      },
    })
  }

  const save = () => saveSettings()

  const handleEnabledChange = (enabled: boolean) => {
    const nextSettings = { ...settings, enabled }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const handleActiveHoursEnabledChange = (active_hours_enabled: boolean) => {
    const nextSettings = { ...settings, active_hours_enabled }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const handleAutoYoloEnabledChange = (auto_yolo_enabled: boolean) => {
    const nextSettings = { ...settings, auto_yolo_enabled }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const setHour = (
    key: 'active_hours_start' | 'active_hours_end',
    value: string
  ) => {
    const parsed = Number.parseInt(value, 10)
    setSettings(current => ({
      ...current,
      [key]: Number.isFinite(parsed) ? parsed : 0,
    }))
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-medium text-foreground">Mr. Robot</h3>
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {MR_ROBOT_SETTINGS_BADGE}
            </Badge>
          </div>
          <Separator className="mt-2" />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 p-4">
          <div className="max-w-2xl">
            <Label className="text-sm text-foreground">
              Mr. Robot issue sweeps
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Poll open GitHub issues, create one Jean worktree per issue, and
              draft a focused plan. Optionally let Mr. Robot yolo the plan too.
            </p>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleEnabledChange}
            disabled={updateSettings.isPending}
          />
        </div>

        <div className="rounded-lg border p-4">
          <h4 className="mb-4 text-sm font-medium text-foreground">
            Schedule and limits
          </h4>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Check every">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={settings.interval_minutes}
                  onChange={event =>
                    setNumber('interval_minutes', event.target.value)
                  }
                />
                <span className="text-sm text-muted-foreground">minutes</span>
              </div>
            </Field>
            <Field label="Issues per run">
              <Input
                type="number"
                min={1}
                value={settings.issue_limit}
                onChange={event => setNumber('issue_limit', event.target.value)}
              />
            </Field>
            <Field label="Max active worktrees">
              <Input
                type="number"
                min={1}
                value={settings.max_parallel_worktrees}
                onChange={event =>
                  setNumber('max_parallel_worktrees', event.target.value)
                }
              />
            </Field>
          </div>

          <Separator className="my-4" />

          <div className="flex items-start justify-between gap-4">
            <div className="max-w-2xl">
              <Label className="text-sm text-foreground">Active hours</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Only start new fixes during these hours (local time). Wraps past
                midnight.
              </p>
            </div>
            <Switch
              checked={settings.active_hours_enabled ?? false}
              onCheckedChange={handleActiveHoursEnabledChange}
              disabled={updateSettings.isPending}
            />
          </div>

          {settings.active_hours_enabled && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="From">
                <Select
                  value={String(settings.active_hours_start ?? 20)}
                  onValueChange={value => setHour('active_hours_start', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map(hour => (
                      <SelectItem key={hour} value={String(hour)}>
                        {formatHour(hour)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="To">
                <Select
                  value={String(settings.active_hours_end ?? 8)}
                  onValueChange={value => setHour('active_hours_end', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map(hour => (
                      <SelectItem key={hour} value={String(hour)}>
                        {formatHour(hour)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
              <h4 className="text-sm font-medium text-foreground">
                Planning
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Plan issues automatically based on the backend model.
              </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Backend">
                <Select
                  value={settings.planning_backend}
                  onValueChange={planning_backend =>
                    setSettings(current => ({
                      ...current,
                      planning_backend,
                      planning_model: null,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                    <SelectItem value="opencode">OpenCode</SelectItem>
                    <SelectItem value="cursor">Cursor</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model">
                <ModelSelect
                  backend={settings.planning_backend}
                  value={settings.planning_model}
                  onChange={planning_model =>
                    setSettings(current => ({ ...current, planning_model }))
                  }
                />
              </Field>
            </div>
          </div>

          <div className="rounded-lg border p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium text-foreground">
                  Yolo execution
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  Automatically approve ready plans and start execution.
                </p>
              </div>
              <Checkbox
                aria-label="Also yolo approved plans"
                checked={settings.auto_yolo_enabled ?? false}
                onCheckedChange={checked =>
                  handleAutoYoloEnabledChange(checked === true)
                }
                disabled={updateSettings.isPending}
              />
            </div>
            <div
              className={
                settings.auto_yolo_enabled
                  ? 'grid gap-4 sm:grid-cols-2'
                  : 'grid gap-4 sm:grid-cols-2 opacity-50'
              }
            >
              <Field label="Backend">
                <Select
                  value={settings.yolo_backend}
                  disabled={!settings.auto_yolo_enabled}
                  onValueChange={yolo_backend =>
                    setSettings(current => ({
                      ...current,
                      yolo_backend,
                      yolo_model: null,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                    <SelectItem value="opencode">OpenCode</SelectItem>
                    <SelectItem value="cursor">Cursor</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model">
                <ModelSelect
                  backend={settings.yolo_backend}
                  value={settings.yolo_model}
                  disabled={!settings.auto_yolo_enabled}
                  onChange={yolo_model =>
                    setSettings(current => ({ ...current, yolo_model }))
                  }
                />
              </Field>
            </div>
          </div>
        </div>

        <Button onClick={save} disabled={updateSettings.isPending}>
          {updateSettings.isPending && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          Save settings
        </Button>
      </div>
    </div>
  )
}
