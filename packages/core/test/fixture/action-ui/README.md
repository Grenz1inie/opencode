# Action registration fixture

Use this simulated calibration lookup with OpenCode's native chat. In a test project, add the absolute file URL of the
`action-ui` directory in `opencode.json`. Enable the experimental flag for the same Location.

```json
{
  "experimental": { "action_ui": true },
  "plugins": [{ "package": "file:///absolute/path/to/action-ui" }]
}
```

Open a new chat in that project and send **Look up the calibration record for CAL-417 at North Lab.** Allow the tool if
prompted. The provider receives `inspect_calibration` with required `instrument` and `lab` inputs. In the timeline,
the result shows `CAL-417 · North Lab` and `PRIMARY-A`. The fixture logs the inputs and the called target.

A plugin entry can set `options.target` to `local://backup` to change the result marker to `BACKUP-B` or
`options.action` to `review_calibration` to change the advertised name. An unregistered `options.target` or
`options.instrumentType` omits that Action and logs its unresolved reference. To test unload, remove the plugin entry
and wait for OpenCode to refresh its Location before starting another chat.
