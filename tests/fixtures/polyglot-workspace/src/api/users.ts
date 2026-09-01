import type { User } from '../domain/user';

export function currentUser(): User {
  return { id: 1, email: 'codraw@example.com' };
}
