# Tối ưu Crawl SPOJ: Restructure StudentCourses + Skip Logic

## Bối cảnh

Hiện tại script crawl **~5,500 user-problem pairs** tuần tự, mỗi pair tốn 2-5s → **~9 giờ**. Phân tích Data.json cho thấy:

| Metric | Số lượng |
|---|---|
| Target users | 170 |
| Total user-problem pairs phải crawl | ~5,500 |
| Pairs đã đạt Score ≥ 100 | ~3,405 (**~62%**) |
| Pairs chưa có submission nào | ~2,700 |
| **Pairs thực sự cần crawl** | **ước tính ~400-800** |

→ **85-90% requests hiện tại là dư thừa**. Tối ưu có thể giảm từ 9h → **30-60 phút**.

## Đề xuất cấu trúc mới cho StudentCourses.json

> [!IMPORTANT]
> **Có nên chia thành problem sets không?** — **CÓ**, vì lợi ích rõ ràng:
> 1. Skip hẳn problem set đã hết hạn (không cần crawl nữa)
> 2. Chỉ crawl submissions trong thời gian cho phép của mỗi set
> 3. Dễ quản lý, dễ thêm/bớt problem sets theo tuần

### Cấu trúc đề xuất

```json
[
    {
        "name": "CSE 202",
        "users": ["ei24sanhnguyen", "ei23sduyngo", ...],
        "problemSets": [
            {
                "name": "Week 1-2: Graph Basics",
                "start": "2026-01-06T00:00:00+07:00",
                "end": "2026-01-19T23:59:59+07:00",
                "problems": ["EIUDFS1", "EIUDFS2", "EIUBFS1", "EIUBFS2"]
            },
            {
                "name": "Week 3-4: Shortest Path",
                "start": "2026-01-20T00:00:00+07:00",
                "end": "2026-02-02T23:59:59+07:00",
                "problems": ["EIMINDISTA", "EIMINSPAN", "EIMAXHTR"]
            }
        ]
    }
]
```

> [!NOTE]  
> Nếu chưa muốn chia chi tiết từng tuần ngay, bạn có thể dùng **1 problem set duy nhất** cho mỗi course với start/end = toàn semester. Sau đó refine dần.

## Proposed Changes

### Logic tối ưu (3 lớp skip)

```
For each user:
  1. [SOLVED FILTER] Lấy danh sách solved problems từ profile page (1 request/user)
  2. For each problem set:
     a. [TIME FILTER] Skip nếu problem set ĐÃ HẾT HẠN (set.end < now)
     b. [INNER JOIN] Chỉ crawl problems ∈ (allowedProblems ∩ solvedProblems)
     c. [SCORE FILTER] Skip nếu user đã có submission Score=100 trong Data.json
        trong khoảng thời gian [set.start, set.end]
     d. Nếu qua hết 3 filter → crawl status page cho (user, problem)
```

---

### Component 1: StudentCourses.json

#### [MODIFY] [StudentCourses.json](file:///d:/Dev/Spoj_Ranking/StudentCourses.json)

Chuyển từ flat `problems[]` sang `problemSets[]` với `start`/`end` cho mỗi set.

> [!WARNING]
> Bạn sẽ cần tự chia problems vào các problem sets với thời gian phù hợp. Tôi sẽ tạo 1 cấu trúc placeholder mà bạn điền thời gian vào.

---

### Component 2: index2.js — Core Crawl Logic

#### [MODIFY] [index2.js](file:///d:/Dev/Spoj_Ranking/index2.js)

**Thay đổi chính:**

1. **Parse cấu trúc mới** của StudentCourses.json (problem sets với start/end)

2. **Bật lại [extractSolvedProblemCodesFromUserProfile](file:///d:/Dev/Spoj_Ranking/index2.js#244-271)** — Inner join với allowed problems:
   ```javascript
   const solvedCodes = await extractSolvedProblemCodesFromUserProfile(page, username);
   const solvedSet = new Set(solvedCodes);
   // Chỉ crawl problems nằm trong CẢ allowedProblems VÀ solvedProblems
   const relevantProblems = allowedProblems.filter(p => solvedSet.has(p));
   ```

3. **Skip problem đã đạt 100 trong time window** — Kiểm tra Data.json trước khi crawl:
   ```javascript
   function hasFullScoreInWindow(userObj, problemId, startIso, endIso) {
       const subs = userObj.Problems?.[problemId]?.Submissions || [];
       const start = new Date(startIso).getTime();
       const end = new Date(endIso).getTime();
       return subs.some(s => 
           s.Score >= 100 && 
           new Date(s.Time).getTime() >= start && 
           new Date(s.Time).getTime() <= end
       );
   }
   ```

4. **Skip expired problem sets** — Không crawl set đã hết hạn:
   ```javascript
   if (new Date(set.end).getTime() < Date.now()) {
       console.log(`  [Skip] Problem set "${set.name}" expired`);
       continue;
   }
   ```

5. **Các tối ưu performance khác** (từ review trước):
   - `waitUntil: "domcontentloaded"` + `waitForSelector("table.problems")` thay vì `networkidle2`
   - Block images/CSS/fonts qua request interception
   - Bỏ [politeDelay()](file:///d:/Dev/Spoj_Ranking/index2.js#55-56) dư ở line 572, 576 (giữ delay trong [safeGoto](file:///d:/Dev/Spoj_Ranking/index2.js#196-202) là đủ)
   - Giảm delay range: 500-1500ms
   - Save Data.json sau mỗi user (resume-safe)

## Ước tính cải thiện

| Trước | Sau |
|---|---|
| ~5,500 page loads | ~400-800 page loads |
| ~9 giờ | **~20-40 phút** |

## Verification Plan

### Manual Verification
1. **Dry-run test**: Thêm flag `--dry-run` in ra danh sách (user, problem) sẽ crawl thay vì crawl thật, so sánh số lượng trước/sau tối ưu
2. **Chạy thật với 1 course nhỏ**: Test với CSE 202 (26 users) trước, kiểm tra Data.json output đúng
3. **So sánh kết quả**: Đảm bảo submissions mới vẫn được merge đúng, không mất data
