FantasyPros CSV overlay
This folder holds weekly CSV exports from FantasyPros that power the
Sleepers, Busts, and Handcuffs sections of the Draft Kit page.
Weekly refresh workflow
For each file below, download the fresh CSV from FantasyPros, copy its
contents, and paste over the existing file on GitHub. You never need to
rename anything — the site expects these exact filenames.
File in this folder	Where to download it from FantasyPros
`sleepers-qb.csv`	Sleepers → QB → Export CSV
`sleepers-rb.csv`	Sleepers → RB → Export CSV
`sleepers-wr.csv`	Sleepers → WR → Export CSV
`sleepers-te.csv`	Sleepers → TE → Export CSV
`busts.csv`	Fantasy Football Busts → Export CSV (all positions in one file)
`handcuffs.csv`	RB Handcuffs → Export CSV
Step-by-step (per file)
Download the fresh CSV from FantasyPros
Open it in any text editor (or double-click and copy-all from Excel)
On GitHub, navigate to this folder
Click on the file you're updating (e.g. `sleepers-qb.csv`)
Click the pencil icon (Edit)
Select all content → delete → paste the new content
Scroll down → commit message like "Update sleepers QB" → Commit changes
Repeat for each file
The Draft Kit page picks up the new data on the next page load — no
workflow trigger needed.
What if a file is missing or malformed?
The section shows a friendly "No data — upload the CSV" message instead
of crashing. Nothing breaks.
