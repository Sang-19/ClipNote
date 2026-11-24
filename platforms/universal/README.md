# Universal integration

Dedicated ChatGPT, YouTube and Udemy adapters remain separate. The Universal
adapter is injected only after the user explicitly enables ClipNote in the
extension popup on an ordinary HTTP(S) webpage. It adds page URL/title metadata
and mounts the shared sidebar in a right-hand in-flow column.

The existing repository does not yet provide a standalone webpage screenshot
save pipeline. Visible-page capture, sidebar-excluding area selection and
full-page scroll/stitch capture require additional UI and capture integration;
they are not claimed as completed by this adapter-only change.
