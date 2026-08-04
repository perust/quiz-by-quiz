import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders quiz start screen', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /상식왕 퀴즈 챌린지/i })).toBeInTheDocument();
  expect(screen.getByLabelText('닉네임 입력')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '게임 시작' })).toBeDisabled();
});
