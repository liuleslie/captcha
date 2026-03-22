# Artifact 1: Diary

This is the meta-folder containing my months-long quest to program a CAPTCHA diary. 

As of early-mid March 2026, this repository has grown to reflect the shift from a [cursor position logger](/Diary/0_yourBiggestFan/README.md) to [CAPTCHA downloader](/Diary/1_Log/README.md) to full [CAPTCHA diary/archive](/Diary/2_Diary/README.md).

## Background

### Why download CAPTCHA media?
CAPTCHAs are an example of a human interactive proof (HIP) that grants selective access to services based on the user’s input. From the academic literature that led to this web security feature, this input is valuable for its utility as training data for machine learning systems.

As a HIP, CAPTCHAs are everyday artifacts that remain an evergreen theme for meditations on how we as (presumably) human users are evaluated. See Paperhat Projects’ [CaptchaWare](https://paperhatprojects.itch.io/captchaware), Neal Agarwal’s [“I’m Not a Robot”](https://neal.fun/not-a-robot/), and [Fun With Computer Vision](https://www.funwithcomputervision.com/)’s [cursed CAPTCHA series](https://x.com/measure_plan/status/19523700746369966300) as examples of such provocations. 

While evaluation methods are unclear (colloquial accounts of user/browser telemetry and cookies aside), I’d argue that this form of user-side data collection is helpful to make encounters with, and data labeling of, CAPTCHAs more concrete and manipulable for personal reflection.

The original goal of developing this Log is to focus on hCaptcha, Arkose MatchKey, and Arkose funCaptcha for their (as personally observed) multi-step, increasingly cognitively burdensome user experience. Given the peculiar development process of this extension, it has been primarily been tested on Google reCAPTCHA for the scheme’s breadth/coverage. Support for these three schemes is ongoing. 

### A note on the code
Major thanks to Ben Pettis for _[HTML Search and Record](https://github.com/bpettis/html-search-and-record)_, which I used as a technical foundation for this extension. This Diary’s code is approximately 1:4 manually written:Claude Code (CC) synthesized, with CC in “Ask before edits” and “Plan” mode alternatingly, featuring long bouts of me metaphorically “talking to myself via large language model” during the first overcast, then promisingly sunny weeks of mid-late January through mid-March, 2026. It was iteratively tested in Firefox v147.0.3. A fully manual poring over the code is long overdue.

## Bibliography
Ben Pettis, _[HTML Search and Record](https://github.com/bpettis/html-search-and-record)_ (2021)

Andrew Searles, Yoshimichi Nakatsuka, Ercan Ozturk, Andrew Paverd,
Gene Tsudik, & Ai Enkoji, [“An Empirical Study & Evaluation of Modern CAPTCHAs”](https://www.usenix.org/system/files/usenixsecurity23-searles.pdf) (2023, USENIX)

Md Imran Hossen & Xiali Hei, [“A Low-Cost Attack against the hCaptcha System”](https://www.xialihei.com/wp-content/uploads/2021/09/WOOT.pdf) (2021, IEEE)