import {
  ActivityIcon,
  BracesIcon,
  ListFilterIcon,
  NetworkIcon,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { useSettingsStore } from "@/lib/settings-store"

/** How much the local backend logs; for troubleshooting, applied at once. */
export function SettingsDiagnosticsSection() {
  const settings = useSettingsStore()

  return (
    <SettingsSection
      title="Backend Logs"
      description="How much the local backend writes to its log. Changes apply immediately."
    >
      <SettingsRow
        icon={<ListFilterIcon />}
        label="Log Level"
        description="The least severe entries written. Normal fits everyday use."
      >
        <Select
          value={settings.backendLogLevel}
          onValueChange={(value) =>
            settings.update({
              backend_log_level:
                value === "debug" || value === "warn" || value === "error"
                  ? value
                  : "info",
            })
          }
        >
          <SelectTrigger aria-label="Log Level" className="w-[150px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="error">Errors</SelectItem>
            <SelectItem value="warn">Warnings</SelectItem>
            <SelectItem value="info">Normal</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        icon={<BracesIcon />}
        label="Log Format"
        description="Plain lines to read yourself, or JSON for log tools."
      >
        <Select
          value={settings.backendLogFormat}
          onValueChange={(value) =>
            settings.update({
              backend_log_format: value === "json" ? "json" : "simple",
            })
          }
        >
          <SelectTrigger
            aria-label="Log Format"
            className="w-[150px]"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="simple">Simple</SelectItem>
            <SelectItem value="json">JSON</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        icon={<NetworkIcon />}
        label="HTTP Trace"
        description="Log every request to the local backend, not only failed ones and ones slower than a second."
      >
        <Switch
          aria-label="HTTP Trace"
          checked={settings.backendTraceHttp}
          onCheckedChange={(value) =>
            settings.update({ backend_trace_http: value })
          }
        />
      </SettingsRow>
      <SettingsRow
        icon={<ActivityIcon />}
        label="Provider Event Trace"
        description="Log every event a provider sends, with one entry per streamed text chunk. The log grows fast; turn it off after debugging."
      >
        <Switch
          aria-label="Provider Event Trace"
          checked={settings.backendTraceProviderEvents}
          onCheckedChange={(value) =>
            settings.update({ backend_trace_provider_events: value })
          }
        />
      </SettingsRow>
    </SettingsSection>
  )
}
