현재 브랜치의 모든 변경사항을 분석하고 GitHub Pull Request를 생성해주세요.

## 단계

1. `git status`로 현재 상태를 확인하고, 커밋되지 않은 변경사항이 있으면 알려주세요.
2. `git log`과 `git diff main...HEAD`로 main 브랜치와의 차이를 분석하세요.
3. 변경사항을 요약하여 PR 제목(70자 이내)과 본문을 작성하세요.
4. 리모트에 푸시되지 않았다면 `git push -u origin <branch>` 로 푸시하세요.
5. `gh pr create`로 PR을 생성하세요. 본문 형식:

```
## Summary
- 변경사항 요약 (1~3개 bullet point)

## Test plan
- [ ] 테스트 항목

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

6. 생성된 PR URL을 알려주세요.
