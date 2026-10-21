import { useState } from "react"
import {
  ArrowUpFromLineIcon,
  BellIcon,
  BellRingIcon,
  CircleDotIcon,
  KeyboardIcon,
  KeyboardMusicIcon,
  MessageSquareTextIcon,
  MessageSquareWarningIcon,
  MouseIcon,
  MousePointerClickIcon,
  TriangleAlertIcon,
  Volume2Icon,
  VolumeIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import {
  nativeNotificationPermission,
  requestNativeNotificationPermission,
  type NativeNotificationPermission,
} from "@/lib/native-notifications"
import { useAppearanceStore } from "@/lib/appearance-store"
import { useSettingsStore } from "@/lib/settings-store"
import {
  KEYBOARD_SOUND_THEMES,
  MOUSE_SOUND_THEMES,
  playUiSoundPreview,
} from "@/lib/ui-sound"

const PERMISSION_TEXT: Record<NativeNotificationPermission, string> = {
  granted: "Allowed. Notifications appear in your system's notification area.",
  default:
    "Not allowed yet. Allow them once so the switches above can notify you.",
  denied:
    "Blocked. Allow notifications for this page in your browser's site settings.",
  unsupported: "This browser can't show system notifications.",
}

/**
 * "Notifications & Sound": the system notifications for background turns,
 * approvals and errors, the in-app toasts and badges, and the interface
 * sounds.
 */
export function SettingsNotificationsSection() {
  const settings = useSettingsStore()
  const a = useAppearanceStore()
  const [permission, setPermission] = useState(() =>
    nativeNotificationPermission()
  )

  return (
    <>
      <SettingsSection
        title="Notifications"
        description="System notifications while BetterC0de is in the background or another chat is open."
      >
        <SettingsRow
          icon={<MessageSquareTextIcon />}
          label="Agent Responses"
          description="When an answer is ready in a chat you are not looking at."
        >
          <Switch
            aria-label="Notify for agent responses"
            checked={settings.notificationAgent}
            onCheckedChange={(value) =>
              settings.update({ notification_agent: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<BellRingIcon />}
          label="Approvals & Questions"
          description="When an agent waits for your approval, an answer or a plan review."
        >
          <Switch
            aria-label="Notify for approvals and questions"
            checked={settings.notificationPermissions}
            onCheckedChange={(value) =>
              settings.update({ notification_permissions: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<TriangleAlertIcon />}
          label="Errors"
          description="When a turn or a tool fails."
        >
          <Switch
            aria-label="Notify for errors"
            checked={settings.notificationErrors}
            onCheckedChange={(value) =>
              settings.update({ notification_errors: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<BellIcon />}
          label="System Permission"
          description={PERMISSION_TEXT[permission]}
        >
          {/* Only a page that has not been asked yet can still ask. */}
          {permission === "default" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                requestNativeNotificationPermission()
                  .then(setPermission)
                  .catch(() => setPermission(nativeNotificationPermission()))
              }}
            >
              Allow Notifications
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="In the app">
        <SettingsRow
          icon={<MessageSquareWarningIcon />}
          label="Error Toasts"
          description="A short message in the corner when something fails."
        >
          <Switch
            aria-label="Error Toasts"
            checked={settings.toastEnabled && settings.toastErrors}
            onCheckedChange={(value) =>
              settings.update(
                value
                  ? { toast_enabled: true, toast_errors: true }
                  : { toast_errors: false }
              )
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<CircleDotIcon />}
          label="Attention Badges"
          description="A count on chats and tabs that wait for your approval or answer."
        >
          <Switch
            aria-label="Attention Badges"
            checked={settings.attentionBadges}
            onCheckedChange={(value) =>
              settings.update({ attention_badges: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Sound">
        <SettingsRow
          icon={<Volume2Icon />}
          label="Interface Sounds"
          description="Typing and click sounds. Off by default."
        >
          <Switch
            aria-label="Interface Sounds"
            checked={a.uiSoundEnabled}
            onCheckedChange={(v) => a.set("uiSoundEnabled", v)}
          />
        </SettingsRow>
        <SettingsRow
          icon={<KeyboardIcon />}
          label="Typing Sounds"
          description="A keypress sound while typing."
        >
          <Switch
            aria-label="Typing Sounds"
            checked={a.uiSoundTypingEnabled}
            onCheckedChange={(v) => a.set("uiSoundTypingEnabled", v)}
            disabled={!a.uiSoundEnabled}
          />
        </SettingsRow>
        <SettingsRow
          icon={<ArrowUpFromLineIcon />}
          label="Key-up Sounds"
          description="A release sound after each key, where the profile has one."
        >
          <Switch
            aria-label="Key-up Sounds"
            checked={a.uiSoundKeyUpEnabled}
            onCheckedChange={(v) => a.set("uiSoundKeyUpEnabled", v)}
            disabled={!a.uiSoundEnabled || !a.uiSoundTypingEnabled}
          />
        </SettingsRow>
        <SettingsRow
          icon={<MousePointerClickIcon />}
          label="Click Sounds"
          description="Buttons, menus and controls."
        >
          <Switch
            aria-label="Click Sounds"
            checked={a.uiSoundClicksEnabled}
            onCheckedChange={(v) => a.set("uiSoundClicksEnabled", v)}
            disabled={!a.uiSoundEnabled}
          />
        </SettingsRow>
        <SettingsRow
          icon={<KeyboardMusicIcon />}
          label="Keyboard Profile"
          description="Which mechanical keyboard the typing sounds come from."
        >
          <Select
            value={a.uiSoundKeyboardTheme}
            onValueChange={(v) => a.set("uiSoundKeyboardTheme", v)}
          >
            <SelectTrigger
              aria-label="Keyboard Profile"
              className="w-[240px]"
              size="sm"
              disabled={!a.uiSoundEnabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {KEYBOARD_SOUND_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          icon={<MouseIcon />}
          label="Click Profile"
          description="Which mouse the click sounds come from."
        >
          <Select
            value={a.uiSoundMouseTheme}
            onValueChange={(v) => a.set("uiSoundMouseTheme", v)}
          >
            <SelectTrigger
              aria-label="Click Profile"
              className="w-[240px]"
              size="sm"
              disabled={!a.uiSoundEnabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MOUSE_SOUND_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          icon={<VolumeIcon />}
          label="Volume"
          description="For all interface sounds. The speaker plays a test."
        >
          <div className="flex w-[240px] items-center gap-2">
            <Slider
              aria-label="Volume"
              min={0}
              max={100}
              value={[a.uiSoundVolume]}
              onValueChange={([v]) => a.set("uiSoundVolume", v)}
              className="flex-1"
              disabled={!a.uiSoundEnabled}
            />
            <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
              {a.uiSoundVolume}%
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Play a test sound"
              title="Play a test sound"
              disabled={!a.uiSoundEnabled}
              onClick={() => {
                playUiSoundPreview({
                  keyboardThemeId: a.uiSoundKeyboardTheme,
                  mouseThemeId: a.uiSoundMouseTheme,
                  volume: a.uiSoundVolume,
                }).catch(() => {
                  /* Expected: sound preview is best-effort */
                })
              }}
            >
              <Volume2Icon className="size-3.5" />
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
