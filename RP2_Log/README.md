# CAPTCHA Log

A Firefox extension to a build an archive of contextual data→information about CAPTCHAs encountered during everyday browsing. Open the inspector tool via web developer tools to view extension logs.

The extension gathers the following data when it detects CAPTCHAs (* for fields still debugging):
- as discrete images: CAPTCHA imagery
- `session.json`:
    - site URL serving the CAPTCHA
    - number of rounds of CAPTCHA data labeling completed*
    - CAPTCHA position within DOM (via nested HTML elements) and viewport
    - CAPTCHA prompt/instructions*
    - user’s cursor position as a series of (x,y) coordinates, sampled on every `mousemove` event (~10–60 Hz depending on hardware/browser).

It exports this data upon either the active tab’s closing or a backup timed interval of 60 seconds to a local folder on the user’s device.



## Background

### Why download CAPTCHA media?
CAPTCHAs are an example of a human interactive proof (HIP) that grants selective access to services based on the user’s input. From the academic literature that led to this web security feature, this input is valuable for its utility as training data for machine learning systems.

As a HIP, CAPTCHAs are everyday artifacts that remain an evergreen theme for meditations on how we as (presumably) human users are evaluated. See Paperhat Projects’ [CaptchaWare](https://paperhatprojects.itch.io/captchaware), Neal Agarwal’s [“I’m Not a Robot”](https://neal.fun/not-a-robot/), and [Fun With Computer Vision](https://www.funwithcomputervision.com/)’s [cursed CAPTCHA series](https://x.com/measure_plan/status/19523700746369966300) as examples of such provocations. 

The original goal of developing this Log is to focus on hCaptcha, Arkose MatchKey, and Arkose funCaptcha for their (as personally observed) multi-step, increasingly cognitively burdensome user experience. Given the peculiar development process of this extension, it has been intermittently tested on Google reCAPTCHA for breadth/coverage. Support for these three schemes is ongoing. 

### A note on the code
Major thanks to Ben Pettis for _[HTML Search and Record](https://github.com/bpettis/html-search-and-record)_, which I used as a technical foundation for this extension. This Log’s code is approximately 1:4 manually written:Claude Code (CC) synthesized, with CC in “Ask before edits” and “Plan” mode alternatingly, featuring long bouts of me metaphorically “talking to myself via large language model” during the overcast weeks of mid-late January through mid-February, 2026. It was iteratively tested in Firefox v147.0.3. A fully manual poring over the code is long overdue.

## Bibliography
Ben Pettis, _[HTML Search and Record](https://github.com/bpettis/html-search-and-record)_ (2021)

Andrew Searles, Yoshimichi Nakatsuka, Ercan Ozturk, Andrew Paverd,
Gene Tsudik, & Ai Enkoji, [“An Empirical Study & Evaluation of Modern CAPTCHAs”](https://www.usenix.org/system/files/usenixsecurity23-searles.pdf) (2023, USENIX)

Md Imran Hossen & Xiali Hei, [“A Low-Cost Attack against the hCaptcha System”](https://www.xialihei.com/wp-content/uploads/2021/09/WOOT.pdf) (2021, IEEE)