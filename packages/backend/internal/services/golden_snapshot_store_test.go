package services

import (
	"context"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

const insertGoldenSnapshotBakingSQL = "insertGoldenSnapshotBakingOperation"
const latestReadyGoldenSnapshotSQL = "latestReadyGoldenSnapshotOperation"
const finishGoldenSnapshotSQL = "finishGoldenSnapshotOperation"
const reclaimStaleBakingSQL = "reclaimStaleBakingOperation"
const supersedeGoldenSnapshotsSQL = "supersedeGoldenSnapshotsOperation"
const listExpiredSupersededSQL = "listExpiredSupersededOperation"
const deleteGoldenSnapshotRowSQL = "deleteGoldenSnapshotRowOperation"
const markBadGoldenSnapshotSQL = "markBadGoldenSnapshotOperation"
const failedGoldenSnapshotBuildersSQL = "failedGoldenSnapshotBuildersOperation"

func (q *fakeGoldenDB) LatestReadyGoldenSnapshot(ctx context.Context, kind string) (id string, at time.Time, err error) {
	err = q.QueryRow(ctx, latestReadyGoldenSnapshotSQL, kind).Scan(&id, &at)
	return
}
func (q *fakeGoldenDB) ClaimGoldenSnapshotBake(ctx context.Context, kind string) (id string, err error) {
	err = q.QueryRow(ctx, insertGoldenSnapshotBakingSQL, kind).Scan(&id)
	return
}
func (q *fakeGoldenDB) FinishGoldenSnapshot(ctx context.Context, id, status, snapshot string) (finished string, err error) {
	err = q.QueryRow(ctx, finishGoldenSnapshotSQL, id, status, snapshot).Scan(&finished)
	return
}
func (q *fakeGoldenDB) ReclaimStaleGoldenSnapshot(ctx context.Context, kind string, age int64) (id string, err error) {
	err = q.QueryRow(ctx, reclaimStaleBakingSQL, kind, age).Scan(&id)
	return
}
func (q *fakeGoldenDB) SupersedeGoldenSnapshots(ctx context.Context, kind, id string) error {
	_, err := q.Exec(ctx, supersedeGoldenSnapshotsSQL, kind, id)
	return err
}
func (q *fakeGoldenDB) DeleteGoldenSnapshot(ctx context.Context, id string) error {
	_, err := q.Exec(ctx, deleteGoldenSnapshotRowSQL, id)
	return err
}
func (q *fakeGoldenDB) MarkBadGoldenSnapshot(ctx context.Context, kind, id string) error {
	_, err := q.Exec(ctx, markBadGoldenSnapshotSQL, kind, id)
	return err
}
func (q *fakeGoldenDB) ExpiredGoldenSnapshots(ctx context.Context, kind string, age int64) ([]runtimeports.GoldenSnapshotVictim, error) {
	rows, err := q.Query(ctx, listExpiredSupersededSQL, kind, age)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []runtimeports.GoldenSnapshotVictim
	for rows.Next() {
		var v runtimeports.GoldenSnapshotVictim
		if err := rows.Scan(&v.ID, &v.SnapshotID); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
func (q *fakeGoldenDB) FailedGoldenSnapshotBuilders(ctx context.Context) ([]runtimeports.GoldenSnapshotBuilder, error) {
	rows, err := q.Query(ctx, failedGoldenSnapshotBuildersSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []runtimeports.GoldenSnapshotBuilder
	for rows.Next() {
		var v runtimeports.GoldenSnapshotBuilder
		if err := rows.Scan(&v.VMID, &v.BuildID); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (q *goldenSnapshotCovDB) LatestReadyGoldenSnapshot(ctx context.Context, kind string) (id string, at time.Time, err error) {
	err = q.QueryRow(ctx, latestReadyGoldenSnapshotSQL, kind).Scan(&id, &at)
	return
}
func (q *goldenSnapshotCovDB) ClaimGoldenSnapshotBake(ctx context.Context, kind string) (id string, err error) {
	err = q.QueryRow(ctx, insertGoldenSnapshotBakingSQL, kind).Scan(&id)
	return
}
func (q *goldenSnapshotCovDB) FinishGoldenSnapshot(ctx context.Context, id, status, snapshot string) (finished string, err error) {
	err = q.QueryRow(ctx, finishGoldenSnapshotSQL, id, status, snapshot).Scan(&finished)
	return
}
func (q *goldenSnapshotCovDB) ReclaimStaleGoldenSnapshot(ctx context.Context, kind string, age int64) (id string, err error) {
	err = q.QueryRow(ctx, reclaimStaleBakingSQL, kind, age).Scan(&id)
	return
}
func (q *goldenSnapshotCovDB) SupersedeGoldenSnapshots(ctx context.Context, kind, id string) error {
	_, err := q.Exec(ctx, supersedeGoldenSnapshotsSQL, kind, id)
	return err
}
func (q *goldenSnapshotCovDB) DeleteGoldenSnapshot(ctx context.Context, id string) error {
	_, err := q.Exec(ctx, deleteGoldenSnapshotRowSQL, id)
	return err
}
func (q *goldenSnapshotCovDB) MarkBadGoldenSnapshot(ctx context.Context, kind, id string) error {
	_, err := q.Exec(ctx, markBadGoldenSnapshotSQL, kind, id)
	return err
}
func (q *goldenSnapshotCovDB) ExpiredGoldenSnapshots(ctx context.Context, kind string, age int64) ([]runtimeports.GoldenSnapshotVictim, error) {
	rows, err := q.Query(ctx, listExpiredSupersededSQL, kind, age)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []runtimeports.GoldenSnapshotVictim
	for rows.Next() {
		var v runtimeports.GoldenSnapshotVictim
		if err := rows.Scan(&v.ID, &v.SnapshotID); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
func (q *goldenSnapshotCovDB) FailedGoldenSnapshotBuilders(ctx context.Context) ([]runtimeports.GoldenSnapshotBuilder, error) {
	rows, err := q.Query(ctx, failedGoldenSnapshotBuildersSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []runtimeports.GoldenSnapshotBuilder
	for rows.Next() {
		var v runtimeports.GoldenSnapshotBuilder
		if err := rows.Scan(&v.VMID, &v.BuildID); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (q goldenSnapshotHDB) LatestReadyGoldenSnapshot(ctx context.Context, kind string) (id string, at time.Time, err error) {
	err = q.QueryRow(ctx, latestReadyGoldenSnapshotSQL, kind).Scan(&id, &at)
	return
}
func (q goldenSnapshotHDB) ClaimGoldenSnapshotBake(ctx context.Context, kind string) (id string, err error) {
	err = q.QueryRow(ctx, insertGoldenSnapshotBakingSQL, kind).Scan(&id)
	return
}
func (q goldenSnapshotHDB) FinishGoldenSnapshot(ctx context.Context, id, status, snapshot string) (finished string, err error) {
	err = q.QueryRow(ctx, finishGoldenSnapshotSQL, id, status, snapshot).Scan(&finished)
	return
}
func (q goldenSnapshotHDB) ReclaimStaleGoldenSnapshot(ctx context.Context, kind string, age int64) (id string, err error) {
	err = q.QueryRow(ctx, reclaimStaleBakingSQL, kind, age).Scan(&id)
	return
}
func (q goldenSnapshotHDB) SupersedeGoldenSnapshots(ctx context.Context, kind, id string) error {
	_, err := q.Exec(ctx, supersedeGoldenSnapshotsSQL, kind, id)
	return err
}
func (q goldenSnapshotHDB) DeleteGoldenSnapshot(ctx context.Context, id string) error {
	_, err := q.Exec(ctx, deleteGoldenSnapshotRowSQL, id)
	return err
}
func (q goldenSnapshotHDB) MarkBadGoldenSnapshot(ctx context.Context, kind, id string) error {
	_, err := q.Exec(ctx, markBadGoldenSnapshotSQL, kind, id)
	return err
}
func (q goldenSnapshotHDB) ExpiredGoldenSnapshots(ctx context.Context, kind string, age int64) ([]runtimeports.GoldenSnapshotVictim, error) {
	rows, err := q.Query(ctx, listExpiredSupersededSQL, kind, age)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []runtimeports.GoldenSnapshotVictim
	for rows.Next() {
		var v runtimeports.GoldenSnapshotVictim
		if err := rows.Scan(&v.ID, &v.SnapshotID); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
func (q goldenSnapshotHDB) FailedGoldenSnapshotBuilders(ctx context.Context) ([]runtimeports.GoldenSnapshotBuilder, error) {
	rows, err := q.Query(ctx, failedGoldenSnapshotBuildersSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []runtimeports.GoldenSnapshotBuilder
	for rows.Next() {
		var v runtimeports.GoldenSnapshotBuilder
		if err := rows.Scan(&v.VMID, &v.BuildID); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
