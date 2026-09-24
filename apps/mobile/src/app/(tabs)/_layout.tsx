import { Tabs } from "expo-router"
import { StyleSheet, View } from "react-native"
import {
  FolderGit2,
  MessagesSquare,
  MonitorSmartphone,
} from "lucide-react-native"
import type { LucideProps } from "lucide-react-native"
import type { ComponentType } from "react"
import { colors, font, radius } from "@/design/theme"
import { useAppStore } from "@/store/app-store"

/**
 * Bottom tab bar in the desktop chrome style: sidebar-colored bar with a
 * hairline top border, Figtree-semibold labels and quiet muted icons. The
 * active tab gets a soft secondary pill behind its icon (the desktop's
 * segmented-control "active fill") instead of just a color flip.
 */
function TabIcon({
  icon: Icon,
  color,
  focused,
}: {
  icon: ComponentType<LucideProps>
  color: LucideProps["color"]
  focused: boolean
}) {
  return (
    <View style={[styles.iconPill, focused && styles.iconPillActive]}>
      <Icon size={20} strokeWidth={focused ? 2.2 : 2} color={color} />
    </View>
  )
}

export default function TabsLayout() {
  const waiting = useAppStore(
    (state) =>
      Object.values(state.requestsByThread).filter(
        (requests) => requests.length > 0
      ).length
  )
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          height: 76,
          paddingTop: 10,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
        },
        tabBarItemStyle: { gap: 2 },
        tabBarLabelStyle: {
          fontSize: 10,
          fontFamily: font.semibold,
          letterSpacing: 0.2,
        },
        sceneStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarBadge: waiting > 0 ? waiting : undefined,
          tabBarBadgeStyle: styles.badge,
          // iOS names a tab "Chats, tab, 1 of 3"; tests find it by id.
          tabBarButtonTestID: "tab-chats",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon icon={MessagesSquare} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarButtonTestID: "tab-projects",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon icon={FolderGit2} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Host",
          tabBarButtonTestID: "tab-host",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon icon={MonitorSmartphone} color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  iconPill: {
    minWidth: 52,
    height: 30,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  iconPillActive: { backgroundColor: colors.surfaceActive },
  // Chats waiting for an answer: the amber of the rows that say so.
  badge: {
    backgroundColor: colors.warning,
    color: colors.primaryForeground,
    fontFamily: font.semibold,
    fontSize: 10,
  },
})
