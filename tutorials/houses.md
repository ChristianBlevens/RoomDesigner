# Houses

A house represents a property being staged for sale. Each house has a name, a scheduled date range, and one or more rooms.

## House Properties

- **Name** — a label for the property (e.g., "123 Oak Street")
- **Start Date / End Date** — the time window when staging is scheduled. This is used for furniture availability tracking

## Furniture Availability

Houses with overlapping date ranges share the same furniture inventory. If a sofa is placed in House A (March 1-15) and you're working on House B (March 10-20), the sofa counts as "in use" during the overlap period. The furniture database shows availability accordingly.

## Managing Houses

- Create, edit, and delete houses from the **calendar** or the **House button** in the controls bar
- Each house's rooms and furniture are isolated — changes in one house don't affect another (except shared inventory counts)
