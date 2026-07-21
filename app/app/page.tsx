import { redirect } from "next/navigation";

/**
 * Root route. Redirects to the dashboard; unauthenticated visitors are then
 * bounced to `/login` by the guarded `(app)` layout.
 */
export default function Page() {
  redirect("/dashboard");
}
