# clips

Social video for lrn.to, kept here because the Instagram Content Publishing API cannot accept a file upload. You hand Meta a video_url and their servers fetch it, so every clip has to sit at a public web address before it can be posted.

## Use the Pages URL, not the raw one

https://maxcadman-blip.github.io/lrn-media/clips/FILENAME.mp4

GitHub Pages serves these as video/mp4. The raw.githubusercontent.com URL for the same file returns application/octet-stream with a nosniff header, which Meta's fetcher rejects. Same bytes, different Content-Type, and only one of them works.

## Adding a batch

Drop the MP4s in this folder. Filenames are the stable part of the URL, so they should not be renamed once a clip has been scheduled. Nothing here is ever deleted for the same reason.
