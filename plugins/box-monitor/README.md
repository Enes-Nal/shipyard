# Box monitor

A screen with memory, swap, disks and load for every online box, sampled
every 15 seconds while Terminal is open, with an hour of sparkline history kept
on this computer. When a box passes 92% of its memory or a disk, it sends a
notification once, and again only after it recovers below 85%.

The status bar already shows each box's memory, so this plugin adds no
status bar item of its own.

SDK used: `addScreen`, `addSidebarItem`, `addCommand`, `api.boxes`,
`api.stats`, `storage`, `notify`, and a returned cleanup function that stops
its timer when the plugin is turned off.
