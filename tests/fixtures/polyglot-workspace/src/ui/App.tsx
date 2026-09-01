import React from 'react';
import { currentUser } from '../api/users';

export const App = (): string => `${React.version}: ${currentUser().email}`;
