# CENTCOM design system

This is the entry point for CENTCOM's interface rules and component library. Update this guide alongside shared components when a pattern changes. The implementations linked below own the actual values; avoid copying them into individual pages.

## Component and token map

| Pattern | Mac / web implementation | iPhone / iPad implementation |
| --- | --- | --- |
| Colors, typography, spacing, radii, motion | [`tokens.css`](../src/styles/tokens.css) | Semantic SwiftUI colors and text styles; [`Appearance.swift`](../ios/CENTCOM/Appearance.swift) |
| Buttons, inputs, chips, focus | [`ui.css`](../src/styles/ui.css) | Native SwiftUI controls; `.compactList()` in `Appearance.swift` |
| Icons | [`icons.ts`](../src/ui/icons.ts), one Lucide outline family | SF Symbols; [`AgentRobotIcon.swift`](../ios/CENTCOM/AgentRobotIcon.swift) for agents |
| Page header | [`ViewHeader.tsx`](../src/shell/ViewHeader.tsx) | Native navigation toolbar, inline title; Instructions uses a leading title for readability |
| Main navigation | [`Sidebar.tsx`](../src/shell/Sidebar.tsx), [`PageMenu.tsx`](../src/shell/PageMenu.tsx) | [`PageNavigation.swift`](../ios/CENTCOM/PageNavigation.swift) |
| Search and inventory controls | [`InventoryToolbar.tsx`](../src/views/InventoryToolbar.tsx) | [`.pageSearch`](../ios/CENTCOM/PageSearch.swift) |
| Filter action | [`FilterButton.tsx`](../src/ui/FilterButton.tsx) | [`FilterButton.swift`](../ios/CENTCOM/FilterButton.swift) |
| Filter choices | [`Select.tsx`](../src/ui/Select.tsx), `inventory-filter-panel` | `InventoryFilterSheet` in [`FilterButton.swift`](../ios/CENTCOM/FilterButton.swift) |
| Menus, popovers, dialogs | [`overlays.tsx`](../src/ui/overlays.tsx) | Native `Menu`, `Picker`, `.popover`, `.sheet` |
| Task filtering | [`taskQuery.ts`](../src/lib/taskQuery.ts) | [`TaskFiltering.swift`](../ios/CENTCOM/TaskFiltering.swift) |
| Activity filtering | [`activityQuery.ts`](../src/lib/activityQuery.ts) | [`ActivityFilters.swift`](../ios/CENTCOM/ActivityFilters.swift) |
| Public website | [`site/`](../site), built by [`build-site.mjs`](../scripts/build-site.mjs) on the same `tokens.css` | n/a |

The public website (`pnpm build:site` → `dist-site/`) is static HTML and CSS with no client JavaScript. Its privacy and support pages are rendered from [PRIVACY.md](PRIVACY.md) and [SUPPORT.md](SUPPORT.md), so edit those files, not the site. `site/site.css` adds only a larger type scale and page layout on top of the app's tokens; the header pairs the "CENTCOM" wordmark with the supplied radar icon, while the download cards use text only. Download links live in [`site/config.mjs`](../site/config.mjs) and read "Coming soon" until they are set. Product screenshots show the fictional demo workspace from `scripts/make-ios-demo.ts`, never real data.

## Foundations

- App branding uses the charcoal and brushed-metal CENTCOM radar artwork with a cream indicator (not covered by the code license; see [NOTICE](../NOTICE)), preserved in [`build/centcom-logo.jpg`](../build/centcom-logo.jpg). Run `node scripts/make-icon.mjs` to regenerate Mac `.icns`, the opaque iOS AppIcon, in-app logo images, and browser/touch icons. The Mac tile has platform padding and rounded corners; iOS masks its square asset. Render the original colors in both light and dark appearances, without tinting or luminance masks: [`CentcomLogo.tsx`](../src/ui/CentcomLogo.tsx) serves the offline screen; Connection uses an original-rendering SwiftUI image. Inside the app's chrome the brand is the plain "CENTCOM" wordmark (`.brand-name` in the sidebar), without the artwork, which reads as an app icon rather than part of the interface. Preserve the artwork's proportions, metal finish, and textured charcoal backing.

- Desktop components use semantic tokens such as `--text`, `--text-2`, `--bg-panel`, `--border`, and `--accent`. Their light and dark definitions live together in `tokens.css`.
- Use the existing 4 px spacing scale (`--s-*`) and radius scale (`--r-*`). Reading columns use `--measure`; page headers use `--header-h`.
- Native views use semantic text styles (`.headline`, `.subheadline`, `.caption`) and system colors so Dynamic Type and appearance settings continue to work. Reserve monospaced text for IDs and code.
- Keep icons within each platform's existing family. Icon-only actions need a meaningful accessibility label and a desktop tooltip. Preserve a clear keyboard focus indicator.
- Touch controls need at least a 44 pt target. Desktop filter buttons are 32 px and expand to 44 px for coarse pointers. Use the platform toolbar's native hit area on iOS.
- Use existing motion tokens and respect Reduce Motion. Selection, expansion, and applied filters must remain understandable without animation.

## Toolbar actions

Settings is a global destination in the navigation/menu. Activity does not need another Settings shortcut. Page toolbars contain actions that affect the current page.

Filters use an icon, consistently across Skills, Instructions, Activity, and native Tasks. Do not introduce another text-only “Filters” toolbar button.

```swift
FilterButton(title: "Filter Skills", active: hasFilters) {
    filtering = true
}
```

```tsx
<FilterButton label="Filter Skills" activeCount={activeCount}
  aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
  onClick={() => setExpanded(!expanded)} />
```

On iOS the outline symbol is `line.3.horizontal.decrease.circle`; the filled variant means a filter is applied. VoiceOver announces the action and whether filters are active. On desktop the icon has an applied-count badge and accessible count. Expansion is independent from application: opening the controls does not mean a filter is active. Sort order is shown in the result summary and does not increase the filter count.

Keep the result count and applied-filter summary visible when controls close. Provide an obvious recovery action for zero results. “Clear filters” removes restrictions; Activity retains the selected order. “Reset” in Activity's control panel also restores newest-first. Native sheets have Reset and Done actions.

## Page responsibilities

| Page | Purpose | Relevant controls |
| --- | --- | --- |
| Tasks / Inbox | Manage the current state of work | Status, priority, assignee, project, labels, due date; task sorting |
| Activity | Read changes and conversations over time | Who acted, event type, newest/oldest order |
| Skills | Browse reusable agent capabilities | All Skills / Libraries, search, library, device, agent, scope, project |
| Instructions | Browse reported instruction files | All / Global / Projects, search, device, agent, scope, project |

Activity's actor means the person or agent who made the event, including historical identities; it is independent of the task's current assignee. Activity filters apply to the feed. The desktop In flight overview remains a separate snapshot of current work. Feed ordering applies to the recent events already fetched by each client; oldest-first is not a request for the beginning of the entire archive. Desktop includes project events; iOS currently links task events to their details.

A change to an agent's instructions (`agent.instructions_changed`) is the one Activity event styled as an alert, because agents act on what it changed: a shield icon and danger-colored verb on Mac (`.feed-row[data-alert]` in [`ActivityFeed.tsx`](../src/views/ActivityFeed.tsx)), with a tinted row when one agent changed another's; `exclamationmark.shield.fill` and red text in `EventRow` on iOS. Both open the agent's home. Do not reuse the alert treatment for ordinary events.

A comment's author, or the owner, can edit or delete it. Both clients decide this from `ServerInfo.caller` and show nothing to anyone else. On Mac the actions are in a `MoreH` menu in the comment card's header: Edit swaps the card for an editor with Cancel and Save, and Delete asks first through `confirm` ([`CommentCard` in `ActivityFeed.tsx`](../src/views/ActivityFeed.tsx)). On iOS they are in the row's context menu, with matching VoiceOver actions: Edit opens `CommentComposer` with the text, and Delete uses a confirmation dialog. An edited comment shows a quiet "edited" ("Edited" on iOS). A deleted one stays in place as italic secondary text, "Comment deleted", plus "by <name>" when someone else deleted it. Both clients use the same wording for the delete confirmation.

Search stays at the top of native pages using `.pageSearch`, above the custom bottom page bar. Advanced inventory filters belong in a disclosure panel on desktop and a native sheet on iOS. Raw file paths and device reports stay in their existing disclosures.

## Extending the library

1. Check the component map before adding a control. Extend an existing component when its behavior matches.
2. Keep shared behavior in a helper and page-specific state in the page. Avoid building a generic framework for a single control.
3. Make corresponding Mac/web and native changes when a pattern is shared. Platform rendering may differ while naming, meaning, defaults, and reset behavior stay consistent.
4. Update this guide and the component together. Link new patterns here so the library remains discoverable.
5. Verify default, applied, cleared, empty, loading/error where relevant, keyboard/VoiceOver labeling, and light/dark states. Test filtering or ordering logic when behavior changes; avoid snapshot tests that merely repeat markup.

Validation commands and simulator UI review setup are in [iOS setup](IOS.md) and the root [README](../README.md). Record what was actually exercised and distinguish source/build verification from installation on a physical device.
