# CAPTCHA Diary
CAPTCHA Diary is a Firefox extension (Manifest V2) that passively records CAPTCHA encounters as you browse — storing images, cursor traces, and metadata in a local IndexedDB archive.

## What’s observed
While Diary is enabled, it will prompt any new browser window opened for consent to “watch” tabs. All future tabs in the window opened will be watched for CAPTCHA media; these tabs’ favicons will be replaced with a gray dot.

The gray dot turns red when you interact with the CAPTCHA elements on the page; a red badge appears in the upper right and pulses while you complete CAPTCHA work.

Either manually selecting the “end” button or closing the tab stops the recording, which is then saved to the sidebar as an entry.

## What’s collected
- URL of website that served the CAPTCHA
- session ID
    - used to link each CAPTCHA encounter to a browser tab; useful if inspecting the detailed `session.json`
- inferred CAPTCHA provider
- approximate duration of the CAPTCHA element’s presence on the page
    - this may not reflect your embodied experience encountering it
- inferred trigger: what activated the CAPTCHA?
- any imagery loaded for the CAPTCHA challenge
- cursor points
    - an approximate record of your cursor’s position and movement across the page
    - animation is available via `SVG` button within the recording’s details.
- viewport; size of your browser window 
- approximate number of rounds of CAPTCHAs served

## What’s exported
There are 2 ways to export things:
- **full export** downloads each recording as a separate folder in a .zip
- **flat export** downloads only the images of selected recordings as a .zip

## What’s searchable
Filter buttons are around for you to sift through your CAPTCHA archive more finely; you can also search by the notes taken in the search bar.

## Known limitations and issues
Diary broadly supports [Google reCAPTCHA v2](https://developers.google.com/recaptcha/docs/versions) (“I’m not a robot” checkbox) challenges. Invisible reCAPTCHA v2 badges, as well as reCAPTCHA v3, which uses scoring and skips any user interaction altogether, are out of scope for this project.

Diary also (somewhat spottily) supports Intuition Machines’ [hCaptcha](https://www.hcaptcha.com/) schemes, however it currently cannot collect motion CAPTCHAs.

Much of this code is the product of a text extrusion/synthesizer by the name of Claude Code; while I reskinned the design using a ShadCN Figma kit, I have not yet tested this with a screen reader and as such accessibility needs rigorous review.

Lastly a little embarrassingly the program may flag false positives; this occurs when text on the page is about CAPTCHAs and matches filtering patterns. If you are willing, you may delete these false positive recordings via selection > export selected > delete (a UI/UX flow I am aware is off and needs fixing).