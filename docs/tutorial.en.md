# Bottom Status Bar User Guide

Tabby Group Server Stats 1.7.6

<!-- This Markdown is the PDF source. Keep PAGE/subtitle markers for reproducible pagination. -->

<!-- PAGE: 1 -->
<a id="page-1"></a>
<!-- subtitle: User guide · 1.7.6 · Learn by configuring a working example -->
## Start using the bottom status bar

This guide starts with an installed plugin. You will control individual panes, edit built-in metrics, create single labels and groups, then build a system/data disk group. Example commands run on the connected Linux server, not in Windows PowerShell on your own computer.

### Open the correct settings page

Open Tabby Settings → Bottom Status Bar and enable Show bottom status bar. Connect to a Linux server you can use for testing. Version 1.7.6 uses a fixed bottom bar; the button at the lower left of each terminal pane controls that pane.

The highlighted Tutorial (PDF) button opens this guide in your default PDF application. A Chinese UI opens the Chinese guide; other languages open the English guide. Use the contents below or PDF bookmarks to navigate. Command blocks contain selectable text.

### Choose your starting point

- [Lower-left menu: Show, Hide and three modes](#page-2)
- [Edit Memory, Network and CPU load defaults](#page-3)
- [Create a single label; page 5 covers color and refresh](#page-4)
- [Edit, duplicate and manage groups and children](#page-6)
- [Select connections, layouts and individual panes](#page-7)
- [Use offline presets, GitHub, JSON import and export](#page-8)
- [Disk walkthrough: pages 9-14 build a complete group](#page-9)
- [Verify results and diagnose missing or empty values](#page-15)

> Try pages 2-4, then the disk walkthrough on page 9. Save a label or group after editing; switches, pane-menu choices and ordering save immediately. Edits, additions, deletions and binding changes automatically reload affected displays and collect new data. Old results cannot overwrite the new configuration. Hidden panes stay hidden; no manual refresh is needed.

<!-- PAGE: 2 -->
<a id="page-2"></a>
<!-- subtitle: First exercise · Control one pane without opening settings -->
## Use the button at the lower left

### 1. Click the button to open its vertical menu

Click the button at the lower left of a terminal pane. Its menu opens above it. Moving through the gap between button and menu keeps it open. Choosing an option, clicking outside, clicking the button again or pressing Escape closes it. It also closes when the terminal context changes.

| Option | What it changes |
| --- | --- |
| Show | Shows the bottom status bar in this pane. |
| Hide | Hides this pane's bar but keeps the button available. |
| Overview | Shows this pane's bar and uses overview for its groups. |
| Carousel | Shows this pane's bar and rotates its groups' children. |
| Static | Shows the bar and members together, keeping each group's horizontal or vertical layout. |

### 2. Hide the bar, then bring it back

Choose Hide, then click the remaining button and choose Overview, Carousel or Static. Any mode automatically shows this pane's bar and saves both visibility and mode; no extra Show action is needed. Choose Show alone to keep the previous mode. Modes affect groups, not standalone labels. The global settings switch must still be enabled.

### 3. Keep a saved three-pane layout off/off/on

Open a saved layout containing three panes. Choose Hide in the first two panes and a mode such as Carousel directly in the third. Close the layout and reopen it from saved profiles. The first two stay hidden; the third stays visible with its chosen mode. Panes can differ even when all three use the same connection.

> Before a pane mode is chosen, each group uses its own configured mode. A pane choice overrides group modes there. Persistence relies on the saved layout and pane position; review your choices after replacing or rearranging its panes.

<!-- PAGE: 3 -->
<a id="page-3"></a>
<!-- subtitle: Second exercise · Memory, Network and CPU load -->
## Make the default metrics work for you

### 1. Enable only the items you need

In Default Metrics, click Enabled/Disabled to toggle an item while keeping its settings. Version 1.7.6 has three defaults: Memory, Network and CPU load. Previously customized CPU or disk defaults may be preserved as single labels during upgrade; check that section before deleting anything.

### 2. Reorder, then edit

Use ↑ and ↓ to reorder defaults. The pencil opens names, icons, colors, types, commands and scope. Network and CPU load are groups: open a main/child member, edit it and save the whole group. Single labels use drag handles for ordering; metric groups use ↑ and ↓.

### 3. Read the values before changing commands

| Default | How to read it |
| --- | --- |
| Memory | The main value is usage percent; hover shows available/total capacity. |
| Network | Download/upload are rates in MB/s with 3 decimals. Hover totals count since interface creation or counter reset, not since SSH login. |
| CPU load | The main value is running/total threads. 1min/5min values are load normalized by logical CPU count. They can exceed 100% and are not busy-CPU percentages. |

Network selection prefers default-route interfaces, otherwise eligible non-loopback interfaces. Containers only expose their own visible counters. Tiny rates may round to 0.000 MB/s without indicating a broken connection.

### 4. Reset only the item you edited

Restore defaults resets that built-in definition. It does not reset the whole plugin or delete your other labels. Disable an item to stop using it temporarily. Background color, opacity and the global refresh interval are near the top of settings.

> Built-in commands include Linux/macOS branches; the disk walkthrough is Linux-specific. Custom commands must suit the target OS. Display settings cannot expose disks or processes that a container does not allow you to see.

<!-- PAGE: 4 -->
<a id="page-4"></a>
<!-- subtitle: Third exercise · Count login sessions and hover for usernames -->
## Create your first single label

Click Add Single Label beside Single Labels to open the form. Enter Login sessions, choose Text Value, leave Suffix empty, and set interval 10 seconds and timeout 15 seconds. Select a user icon, enter a FontAwesome name or upload an SVG.

### 1. Check that who is available

```sh
command -v who >/dev/null 2>&1 && echo exists
```

Paste this in Object Check Command. Choose Output Text and expect exists; set failure text to No who. Text comparison trims surrounding whitespace. Alternatively, remove && echo exists, choose Exit Code and expect 0. Printed text 0 is different from exit status 0.

### 2. Fill in the primary command

```sh
data=$(who 2>/dev/null) || exit 1
printf '%s\n' "$data" | awk 'NF {n++} END {print n+0}'
```

### 3. Fill in Hover Detail Command

```sh
data=$(who 2>/dev/null) || exit 1
printf '%s\n' "$data" | awk '
  NF {users[$1]=1}
  END {for (u in users) {print u; n++}
       if (!n) print "No logged-in users"}'
```

Save and return to the terminal. The label counts login sessions; hovering opens a popup above the bar with unique usernames. It lists users visible to who, not just your own SSH account. One person may have several sessions; who can also be empty inside a container.

> An empty check runs the primary command directly. An empty detail field gives no extra information. A failed check blocks both commands. Test them in the same SSH terminal before saving.

<!-- PAGE: 5 -->
<a id="page-5"></a>
<!-- subtitle: Fourth exercise · Build a readable and reliable label -->
## Make numbers, colors and timing agree

### 1. Keep numeric output simple

Output a number and put its unit in Suffix. Text Value suits counts, capacity and percent. Progress Bar also needs a maximum, usually 100. Details can return free/total GB. Numeric columns use thousands separators and align both sides of a ratio independently.

GB retains the existing 1024³-byte calculation; do not convert it again. Network MB/s uses 1,000,000 bytes/second and 3 decimals. Color rules still compare original numbers.

### 2. Put the most severe rule first

Choose Add Rule under Conditional Color Rules, then enter the comparison, threshold and color. The first matching rule wins; otherwise the default color applies. High usage and low free space need opposite comparisons.

| Metric | First: red #ff0000 | Second: orange #ffa500 |
| --- | --- | --- |
| GPU memory usage | > 80 | > 50 |
| Memory usage | > 80 | > 60 |
| 1min / 5min load | > 150 | > 100 |
| Free GB per disk | < 20 | <= 40 |
| Total free GB | < 50 | <= 100 |

Use #00ff00 as the default green. Usage rules are strictly greater-than: exactly 80 does not match > 80. Disk rules put red first; exactly 20 or 40 free GB is orange. Running/total thread text is not a usage percentage.

### 3. Separate sampling from rotation

A label's Interval controls sampling; empty uses the global default. Carousel Interval controls display rotation. Timeout limits execution wait. Try 20-second sampling and a 60-second timeout for slow commands. Hover details are cached; repeated mouse movements do not each start another command.

> No data is not proof of excessive refresh frequency. Empty standard output, a missing tool, permissions or command failure can also cause it. Test the exact command and its exit status on the same connection before adjusting timing.

<!-- PAGE: 6 -->
<a id="page-6"></a>
<!-- subtitle: Fifth exercise · Modes, duplication and maintenance -->
## Organize repeated devices into a group

### 1. Create a main member and children

Choose Add Group and name it. Fill in its main member and children. Members have independent commands and intervals but share scope. The group name appears in settings and hover headings. Existing groups open collapsed; click a member to edit it.

| Group mode | Try this behavior |
| --- | --- |
| Overview | Normally shows the main member; hover opens the whole group above the bar. |
| Carousel | Rotates children in order; hover pauses and opens the whole group above. Width stays steady, and excluded failed children are skipped. |
| Static horizontal | Shows members in one row; hover expands only the member under the pointer. |
| Static vertical | Stacks compact rows with thin separators; hover expands details for all members. |

The lower-left pane menu overrides group mode. Static keeps the group's orientation; carousel timing does not change sampling.

### 2. Duplicate a child

Choose Duplicate Child in the editor. The independent copy appears in that group. Change its name and device/path in all three commands, then save the group. Copying does not discover devices automatically.

### 3. Duplicate the whole group

Choose Duplicate Group on its card. Review its name, scope and commands, or both groups may appear on one connection. Use ↑ and ↓ to reorder groups or children.

### 4. Disable temporarily; delete deliberately

Enabled/Disabled keeps commands and rules; groups and members have separate switches. Deletion asks you to confirm the displayed name. Deleting a group removes its members too.

> Show this label when its check fails controls visibility in all modes. Keep in carousel when its check fails applies only while the failed label remains visible. Disk failure notices are useful; nonexistent GPU slots can be hidden.

<!-- PAGE: 7 -->
<a id="page-7"></a>
<!-- subtitle: Sixth exercise · Distinguish panes of the same connection -->
## Target the right connections and panes

### 1. Select a restricted scope

A label or group starts with All terminal panes. Change Display Scope to Selected connections or layouts, search and check the intended connection. Members share the group scope. Use separate groups for servers that need different disk commands.

### 2. Select panes inside a saved layout

Layouts start expanded. Indented entries represent individual panes, including saved connection copies whose original standalone profile was deleted. A layout checkbox selects its panes together; choose individual entries when only one should show the group.

### 3. Check matching IDs, then uncheck exceptions

Checking one connection selects other entries with the same connection ID, including layout copies. Unchecking removes only that entry. This lets you select matching connections together and then exclude unwanted panes. Equal names with different IDs are not merged.

For example, a layout has two panes for server A and one for B. Bind the A disk group to the A entries and the B group to B. Then use each pane's lower-left button to decide whether its entire bar is visible. Scope and bar visibility solve different problems.

### 4. Review scope after deleting profiles or editing layouts

Invalid targets remain marked Deleted or unavailable. Remove or replace them. An empty selected scope shows nowhere; it never silently becomes global. To show everywhere, deliberately choose All terminal panes.

> Reopen layouts that were already open before installation, or newly saved from current splits, from the saved-profile list once to establish their origin. Ordinary connection binding does not require this. Recheck scope and persisted menu choices after replacing or rearranging saved panes.

<!-- PAGE: 8 -->
<a id="page-8"></a>
<!-- subtitle: Seventh exercise · Offline, GitHub and JSON workflows -->
## Start from presets and share your work

### 1. Search and inspect an offline preset

Bundled presets work offline. Search for GPU or disk, read the description, commands and suggested connection targets, then choose Add. It becomes an editable label/group and executes according to its scope. P0-P4 and other Author laboratory only presets are for the author's own lab; others should not download or use them. Build your own disk group instead. In 1.7.6, the P3 disk template lists /, /data and /data2; review paths in existing groups separately.

### 2. Fetch the GitHub preset library

Choose Import from GitHub and wait. The displayed source points to this plugin repository's main preset library. Import loads a preview; it does not update or overwrite installed labels. Only Add activates a preset. If networking fails, use bundled presets or a JSON file.

### 3. Do not add repeatedly to refresh

An installed preset shows Already added and cannot be added again. Identity uses its source and stable ID, with commands/scope as a legacy fallback, not just its name. Renaming or disabling does not make it new. Enable the existing item to resume; use Duplicate Group/Child for similar devices.

### 4. Import a colleague's JSON library

Choose Import JSON, select a valid library and inspect it before Add. Portable bindings are matched by saved connection names. Missing or ambiguous names produce a warning and restricted scope. Open the new item's Display Scope and choose the correct connections/layouts before use. This does not restore all Tabby settings.

### 5. Review what you export

Export my labels saves custom single labels and groups with portable binding names. It excludes built-in edits and pane-menu choices, and is not an SSH account backup. Command text and connection names are included; check for private paths or tokens before sharing.

> Test your exported file in a test configuration before handing it to colleagues. Importing the library previews choices without executing commands; choosing Add activates their configured collection.

<!-- PAGE: 9 -->
<a id="page-9"></a>
<!-- subtitle: Disk walkthrough · Begin the complete example here -->
## Build your first disk group

You will create a group named Disk demo in a Linux SSH pane. Its main label shows total free space across the system disk and a data disk. Children show / and /data separately. Hover over the overview to see free / total capacity for every disk.

> Example result: Total free 1,240 GB, with System disk 40 GB and /data 1,200 GB below it. These are illustrative readings, not measurements from your server.

### Prepare one SSH connection

Open your target Linux server in Tabby. Commands in this guide run as that connection's remote user, not on your Windows computer. Try each command in that terminal before pasting it into settings so that errors are easy to diagnose.

You need Linux df, awk, stat, findmnt and mountpoint. Python and sudo are not required. The example assumes /data is a separate mounted filesystem. If your data disk uses another path, find it on the next page before continuing.

### Open the editor

Open Tabby Settings → Bottom Status Bar. The page contains default metrics, a preset library, single labels and metric groups. A new configuration provides Memory, Network and CPU load. The disk group you create here is a separate, editable item.

Choose Add Group beside Metric Groups. Enter Disk demo as its name, select Overview and temporarily leave Display Scope at All terminal panes. Verify it on a test connection, then restrict the scope on page 7.

> For version 1.7.6. Editing an existing group with its pencil button starts with members collapsed. Click a main/child member heading to open it. A newly created group opens its main member so you can start typing.

Continue on page 10 to verify paths, pages 11-12 for the main member, page 13 for the system disk, page 14 for copied data disks and page 15 for verification. Scope and pane-menu instructions are on pages 7 and 2.

<!-- PAGE: 10 -->
<a id="page-10"></a>
<!-- subtitle: Step 1 · Check the paths in your SSH terminal -->
## Find the real data mount

```sh
findmnt -rn -o TARGET,SOURCE,FSTYPE
df -Pk /
mountpoint -q /data && echo exists
df -Pk /data
```

Find your data path in the TARGET column. The mountpoint check must print exists for /data to be an actual mount. An existing directory alone is not enough: a disk can disappear while its empty mount directory remains, and df /data may then report the system filesystem instead.

If your mount is /mnt/data, replace every /data in the example, including both main-label path lists and all three child commands. Leave /boot/efi, temporary filesystems and unrelated directories out of the group.

### Step 2 · Fill in the main label

| Field | Value for this exercise |
| --- | --- |
| Label | Total free |
| Type / Suffix | Text Value / GB |
| Default color | #00ff00 |
| Interval / Timeout | 20 seconds / 60 seconds |
| Object Check Command | Leave blank; the aggregate validates each disk. |

The primary command outputs only a number, so put GB in Suffix. The detail command outputs its own free/total GB text. Numeric values use thousands separators, such as 1,240. Color rules continue comparing the original number.

### Understand the command sequence

The object check runs first. Only a successful check permits the primary command, which supplies the normal reading. The hover detail command supplies extra information when needed. With no check, the primary command runs directly; with no detail command, only the reading is shown.

> GB is this plugin's capacity display label for the existing base-1024 calculation: 1024³ bytes per unit. It is not a new decimal conversion, so existing readings and thresholds are preserved. Network rate MB/s is decimal.

<!-- PAGE: 11 -->
<a id="page-11"></a>
<!-- subtitle: Step 3 · Main label: Command (Shell) -->
## Calculate total free space

Paste this entire block into the main label's primary command. The list currently contains / and /data. When adding another disk, update this list and the identical list in the next page's detail command.

```sh
rows=$(
  for p in '/' '/data'; do
    if [ "$p" != / ]; then
      mountpoint -q -- "$p" 2>/dev/null || continue
    fi
    dev=$(stat -Lc '%d' -- "$p" 2>/dev/null) || continue
    data=$(df -Pk -- "$p" 2>/dev/null) || continue
    now=$(stat -Lc '%d' -- "$p" 2>/dev/null) || continue
    [ "$dev" = "$now" ] || continue
    if [ "$p" != / ]; then
      mountpoint -q -- "$p" 2>/dev/null || continue
    fi
    printf '%s\n' "$data" | awk -v dev="$dev" '
      NR == 2 && NF >= 6 && $2 ~ /^[0-9]+$/ &&
      $4 ~ /^[0-9]+$/ && $2 > 0 && $4 <= $2 {
        printf "%s %s %s\n", dev, $2, $4
      }'
  done
)
printf '%s\n' "$rows" | awk '
  NF == 3 && !seen[$1]++ {total += $2; free += $3; n++}
  END {
    if (!n || total <= 0) exit 1
    printf "%.0f\n", int(free / 1048576)
  }'
```

The command skips unmounted or unreadable data disks. It deduplicates filesystem device IDs so that a bind mount is not counted twice. The final output is one integer: total free capacity across valid filesystems.

> Run it in the terminal first: success should print only a number. With no readable valid disk it fails instead of disguising an error as zero free space. The separate main-label check is intentionally blank because this command validates each candidate.

<!-- PAGE: 12 -->
<a id="page-12"></a>
<!-- subtitle: Step 4 · Main label: Hover Detail Command -->
## Add free / total details

Paste this entire block into the main label's detail field. It uses the same paths and deduplication as the primary command, but returns free / total capacity with one decimal place.

```sh
rows=$(
  for p in '/' '/data'; do
    if [ "$p" != / ]; then
      mountpoint -q -- "$p" 2>/dev/null || continue
    fi
    dev=$(stat -Lc '%d' -- "$p" 2>/dev/null) || continue
    data=$(df -Pk -- "$p" 2>/dev/null) || continue
    now=$(stat -Lc '%d' -- "$p" 2>/dev/null) || continue
    [ "$dev" = "$now" ] || continue
    if [ "$p" != / ]; then
      mountpoint -q -- "$p" 2>/dev/null || continue
    fi
    printf '%s\n' "$data" | awk -v dev="$dev" '
      NR == 2 && NF >= 6 && $2 ~ /^[0-9]+$/ &&
      $4 ~ /^[0-9]+$/ && $2 > 0 && $4 <= $2 {
        printf "%s %s %s\n", dev, $2, $4
      }'
  done
)
printf '%s\n' "$rows" | awk '
  NF == 3 && !seen[$1]++ {total += $2; free += $3; n++}
  END {
    if (!n || total <= 0) exit 1
    printf "%.1f/%.1f GB\n", free/1048576, total/1048576
  }'
```

For example, 1,240.5/8,000.0 GB means 1,240.5 is available out of a total of 8,000.0. The left value is free space, not used space. Each numeric column is independently right-aligned so that rows are easy to compare.

> Both main commands must list the same mount paths. Editing only one can make the primary value and hover totals disagree. To include another disk, add its quoted path to both for p in lists.

<!-- PAGE: 13 -->
<a id="page-13"></a>
<!-- subtitle: Step 5 · Give / its own row -->
## Add the system-disk child

Choose Add Child. Enter System disk as its label, Text Value as type, GB as suffix, 20 seconds as interval and 60 seconds as timeout. Set the object check comparison to Output Text and Expected Value to exists.

### Object Check Command

```sh
test -d / && df -Pk / >/dev/null 2>&1 && echo exists
```

### Primary command: system-disk free space

```sh
data=$(df -Pk -- '/' 2>/dev/null) || exit 1
printf '%s\n' "$data" | awk '
  NR == 2 && NF >= 6 && $2 ~ /^[0-9]+$/ &&
  $4 ~ /^[0-9]+$/ && $2 > 0 && $4 <= $2 {
    t=$2; a=$4; ok=1
  }
  END {if (!ok) exit 1; printf "%.0f\n",int(a/1048576)}'
```

### Hover Detail Command

```sh
data=$(df -Pk -- '/' 2>/dev/null) || exit 1
printf '%s\n' "$data" | awk '
  NR == 2 && NF >= 6 && $2 ~ /^[0-9]+$/ &&
  $4 ~ /^[0-9]+$/ && $2 > 0 && $4 <= $2 {
    t=$2; a=$4; ok=1
  }
  END {if (!ok) exit 1; printf "%.1f/%.1f GB\n",a/1048576,t/1048576}'
```

Set Check Failure Text to Unavailable. Leave Show this label when its check fails enabled so that a missing or unreadable disk leaves a visible notice rather than silently disappearing.

> Choose Save Group, return to your SSH pane and verify the readings. All group members save together. If saving is disabled, check that every member has a label or icon and a nonempty primary command.

<!-- PAGE: 14 -->
<a id="page-14"></a>
<!-- subtitle: Step 6 · Reuse your working system-disk label -->
## Copy a child and add alerts

Edit Disk demo again. Use Duplicate Child on the System disk child to create an independent child in the same group. Open that copy, rename it /data and retain the suffix and refresh settings. Editing a copy does not update its source.

### Change the check to test a real mount

```sh
mountpoint -q -- /data 2>/dev/null && echo exists
```

Keep Output Text and the expected value exists; change the failure text to Not mounted. In both copied data commands, replace the quoted '/' immediately after df -Pk -- with '/data'. Do not replace arithmetic division slashes.

### Both df lines should now look like this

```sh
data=$(df -Pk -- '/data' 2>/dev/null) || exit 1
```

For /data2, copy the /data child, then change its name and all three command paths. Also add /data2 to both main-label path lists. Copying a whole group is useful for another server with different mounts; review the copy's display scope to prevent both groups appearing on one connection.

### Warn when free space becomes low

| Member | First rule | Second rule |
| --- | --- | --- |
| Each disk child | < 20 → #ff0000 | <= 40 → #ffa500 |
| Total-free main label | < 50 → #ff0000 | <= 100 → #ffa500 |

Rules match from top to bottom; the first match wins. Put red before orange and keep the default color #00ff00. A child at exactly 20 or 40 is orange; above 40 it is green. Total free at exactly 50 or 100 is orange.

For disks, keeping failure notices visible is useful. Turn off Keep in carousel when its check fails if you want the carousel to skip missing disks. Turning off Show this label when its check fails hides that child in every mode and also removes it from the carousel. Save the group to apply your edits.

> Check same-name copies and update all three child commands plus both main path lists. Saving refreshes data automatically; it does not fix old paths or remove an unwanted copy. Review each copy's scope too.

<!-- PAGE: 15 -->
<a id="page-15"></a>
<!-- subtitle: Final disk step · Three small checks and a recovery path -->
## Verify it before relying on it

### 1. Compare the readings

Compare df -Pk / and df -Pk /data with Available divided by 1024². Allow one refresh. Primary values round down; details keep one decimal, so a difference below 1 GB is expected.

### 2. Simulate a missing disk safely

Copy /data and change its name and all three paths to /not-a-real-mount. Save: it should say Not mounted. Remove the test copy afterward, checking its name in the deletion dialog. Do not unmount a working disk for this test.

### 3. Reopen the saved layout

Hide one pane and choose Carousel in another. Reopen that layout from saved profiles and verify both choices. Review bindings if you later replace or reposition its panes.

### Start with the matching symptom

| Symptom | Next check |
| --- | --- |
| No label at all | Pane visibility, group enable switch and selected scope. |
| Not mounted notice | Run the check in the same SSH terminal; compare output/code. |
| Reading but no details | Ensure the detail field is filled and its command prints output. |
| Timeout or error | Command syntax, tools and access; then interval and timeout. |
| Unexpectedly small total | Missing disks are skipped; one filesystem is counted once. |
| Old or duplicate group | Check same-name copies, member paths and scope; disable the old copy. |

mountpoint -q prints no success text. For Output Text, append && echo exists and compare exists. For Exit Code, use mountpoint -q alone and expect 0.

Disable keeps commands and rules; deletion removes them. Restore defaults resets that built-in. Preset import only previews choices; Add activates them. Author-laboratory P0-P4 presets are not general templates.

> Your disk group now checks mounts, reports failures and follows its selected scope. For each new disk, update three child commands and both aggregate path lists, as shown on page 14.
