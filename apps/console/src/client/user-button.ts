/**
 * The shell's user button follows a name saved from inside the page (spec 19.2, B3-10): the
 * Agent home's "What should I call you?" form saves the first name without leaving the page, so
 * the sidebar and phone-sheet copies of the button take the new name and initials at once
 * instead of keeping the server-rendered email until a reload.
 */

export interface ProfileSaved {
  email: string;
  name: string;
  hasRealName: boolean;
  avatar: { initials: string; imageUrl: string | null };
}

export const PROFILE_SAVED_EVENT = "nz:profile-saved";

/** What the user button shows: the real name over the email, or the email alone. */
export function userButtonText(person: Pick<ProfileSaved, "email" | "name" | "hasRealName">): {
  name: string;
  email: string | null;
} {
  return person.hasRealName
    ? { name: person.name, email: person.email }
    : { name: person.email, email: null };
}

function repaint(person: ProfileSaved): void {
  const text = userButtonText(person);
  for (const trigger of document.querySelectorAll<HTMLElement>(".nz-user-trigger")) {
    trigger.title = text.name;
    const name = trigger.querySelector<HTMLElement>(".nz-user-name");
    if (name) name.textContent = text.name;
    let email = trigger.querySelector<HTMLElement>(".nz-user-email");
    if (text.email) {
      if (!email && name) {
        email = document.createElement("span");
        email.className = "nz-user-email";
        name.after(email);
      }
      if (email) email.textContent = text.email;
    } else {
      email?.remove();
    }
    // Initials drawn on a color follow the name; an image avatar stays as it is.
    const avatar = trigger.querySelector<HTMLElement>("span.nz-avatar");
    if (avatar && !person.avatar.imageUrl) avatar.textContent = person.avatar.initials;
  }
}

export function announceProfileSaved(person: ProfileSaved): void {
  document.dispatchEvent(new CustomEvent<ProfileSaved>(PROFILE_SAVED_EVENT, { detail: person }));
}

export function initUserButton(): void {
  document.addEventListener(PROFILE_SAVED_EVENT, (event) => {
    const person = (event as CustomEvent<ProfileSaved>).detail;
    if (person && typeof person.email === "string") repaint(person);
  });
}
