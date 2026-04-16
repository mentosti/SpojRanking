// Test API pagination and find total submissions
async function main() {
    // 1. Find last page via binary search
    let lo = 1, hi = 1000;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const resp = await fetch("https://oj.eiu.edu.vn/api/v2/submissions?page=" + mid);
        const json = await resp.json();
        if (json.data && json.data.objects && json.data.objects.length > 0) {
            lo = mid;
            if (json.data.has_more) lo = mid;
            else { hi = mid; break; }
        } else {
            hi = mid - 1;
        }
    }
    console.log("Last page:", lo);

    // 2. Check first and last page content
    const firstPageResp = await fetch("https://oj.eiu.edu.vn/api/v2/submissions?page=1");
    const firstPage = await firstPageResp.json();
    const fp = firstPage.data;
    console.log("\nPage 1:");
    console.log("  First sub: id=" + fp.objects[0].id + " date=" + fp.objects[0].date);
    console.log("  Last sub:  id=" + fp.objects[fp.objects.length-1].id + " date=" + fp.objects[fp.objects.length-1].date);

    const lastPageResp = await fetch("https://oj.eiu.edu.vn/api/v2/submissions?page=" + lo);
    const lastPage = await lastPageResp.json();
    const lp = lastPage.data;
    console.log("\nPage " + lo + ":");
    console.log("  Count: " + lp.objects.length);
    console.log("  First sub: id=" + lp.objects[0].id + " date=" + lp.objects[0].date);
    console.log("  Last sub:  id=" + lp.objects[lp.objects.length-1].id + " date=" + lp.objects[lp.objects.length-1].date);
    console.log("  has_more: " + lp.has_more);

    const total = (lo - 1) * 1000 + lp.objects.length;
    console.log("\nEstimated total submissions: " + total);
}
main().catch(console.error);
