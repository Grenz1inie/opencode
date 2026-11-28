# Flight Action

OpenCode Web chat is the entry point for the flight demo. The Agent calls `find_flights` from a chat prompt. OpenCode renders the missing-input form and the HXL flight cards in the active conversation. The card actions carry the query forward through the registered target.

## Chat acceptance

Start OpenCode Web with `experimental.flight_action` enabled and select a model that supports tool calls. Use a new chat for each initial prompt. If OpenCode asks for permission, choose **Allow once**.

| Chat step | Expected result |
| --- | --- |
| Send `查杭州到成都的航班`. | The form shows the Hangzhou–Chengdu route and asks only for the departure date. The target has not run. |
| Enter `2026-12-05` and submit. | Two flight cards show the route, date, flight numbers, departure and arrival times, durations, and simulated fares. The first fare is ¥560. The target runs once. |
| Choose **Change date** on the completed card. Submit `2026-12-06` after checking the prefilled date. | Opening the form leaves the target count at one. Submitting preserves both cities, updates the date and first fare to ¥570, and increases the count to two. |
| In a new chat, send `查杭州到成都 2026 年 12 月 8 日的航班`. Choose **Retry search** on the failed result and allow it. | The failure keeps both cities and December 8 visible. The retry runs the same query once more and replaces the failure with two cards for December 8. |

For complete input, send `查杭州到成都 2026 年 12 月 5 日的航班`. Expect two cards from one target call and zero missing-input forms. December 4 is a successful empty result with a **Change date** action. Denying or cancelling permission for a query, change, or retry adds zero target calls.
