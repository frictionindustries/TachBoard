import { test, expect } from "./fixtures";

// More registrations than the default 32-account cap across fresh test
// lifecycles. No browser required: exercises the same baseURL fixture as page.
for (let i = 0; i < 33; i++) {
  test(`isolated registration ${i + 1}`, async ({ request }) => {
    const response = await request.post("/api/auth/register", {
      data: { username: "same_test_user", password: "Lifecycle-password-123!" },
    });
    expect(response.status()).toBe(201);
    const { user } = await response.json();
    expect(user.id).toBe(1);
    const duplicate = await request.post("/api/auth/register", {
      data: { username: "same_test_user", password: "Lifecycle-password-123!" },
    });
    expect(duplicate.status()).toBe(400);
  });
}