# Run with `bin/rails runner` from the backend. Serves the few backend steps the dashboard API cannot do,
# only for this run's campaigns and identifiers. One JSON request per line, one JSON answer per line.
require "socket"
require "json"
require "sidekiq/api"

RUN_ID = ENV.fetch("HOST_TEST_RUN_ID")
PROJECT = Project.find(Integer(ENV.fetch("HOST_TEST_PROJECT_ID", "2796")))
PORT = Integer(ENV.fetch("HOST_HELPER_PORT", "4809"))
CAMPAIGN_PREFIX = "zz-qa host #{RUN_ID} ".freeze
IDENTIFIER = /\Azz-qa-host-#{Regexp.escape(RUN_ID)}(-[a-z0-9]+)*\z/
ActiveRecord::Base.logger = nil
Rails.logger.level = :warn

def own_campaign(hashid)
  campaign = PROJECT.in_app_campaigns.find_by_hashid(hashid.to_s)
  raise "campaign #{hashid} not found" if campaign.nil?
  raise "campaign #{hashid} is not this run's" unless campaign.name.start_with?(CAMPAIGN_PREFIX)

  campaign
end

def profile_count(visitor_id, identifier)
  sql = "SELECT count() AS n FROM user_profiles WHERE project_id = #{PROJECT.id} AND visitor_id = #{Integer(visitor_id)} " \
        "AND sdk_identifier = '#{identifier}'"
  Clickhouse.with { |conn| conn.select_all(sql) }.to_a.first&.fetch("n").to_i
end

def own_segment(hashid)
  segment = PROJECT.segments.find_by_hashid(hashid.to_s)
  raise "segment #{hashid} is not this run's" if segment && !segment.name.start_with?(CAMPAIGN_PREFIX)

  segment
end

# Jobs these records queued that nothing works here, matched by their exact arguments.
def drop_jobs(klass, queue, args = nil, &match)
  dropped = 0
  [Sidekiq::Queue.new(queue), Sidekiq::ScheduledSet.new, Sidekiq::RetrySet.new].each do |set|
    set.each do |job|
      next unless job.klass == klass && (match ? match.call(job.args) : args.include?(job.args))

      job.delete
      dropped += 1
    end
  end
  dropped
end

# Hard-deletes this run's campaigns and segments by exact id, with what hangs off them.
def purge(campaign_ids, segment_ids)
  out = Hash.new(0)
  Array(campaign_ids).uniq.each do |hashid|
    campaign = PROJECT.in_app_campaigns.find_by_hashid(hashid.to_s)
    next if campaign.nil?
    raise "campaign #{hashid} is not this run's" unless campaign.name.start_with?(CAMPAIGN_PREFIX)

    campaign.end! if InAppCampaign::ACTIVE.include?(campaign.status)
    key = campaign.segment_key
    %i[portrait_image landscape_image].each { |slot| campaign.public_send(slot).purge if campaign.public_send(slot).attached? }
    out[:media] += campaign.media.attachments.size
    campaign.media.purge
    out[:jobs] += drop_jobs("InAppMembershipPopulateJob", "egress_exports") { |args| args.first == campaign.id }
    campaign.destroy!
    out[:campaigns] += 1
    next if key.nil? || InAppCampaign.exists?(segment_key: key) || InAppMemberships.journey_keys(PROJECT.id).include?(key)

    out[:memberships] += SegmentMembership.where(project_id: PROJECT.id, segment_key: key).delete_all
    out[:jobs] += drop_jobs("InAppMembershipCleanupJob", "maintenance", [[[key]]])
  end
  segments = Array(segment_ids).uniq.filter_map { |hashid| own_segment(hashid) }
  segments.each do |segment|
    raise "segment #{segment.hashid} still has campaigns" if InAppCampaign.exists?(segment_id: segment.id)
    raise "segment #{segment.hashid} has exports" if SegmentExport.exists?(segment_id: segment.id)

    out[:jobs] += drop_jobs("PurgeSegmentIdentifierGenerationsJob", "maintenance", [[segment.id]])
    segment.destroy!
    out[:segments] += 1
  end
  if segments.any?
    ids = segments.map { |segment| Integer(segment.id) }.join(", ")
    Clickhouse.with { |conn| conn.execute("ALTER TABLE segment_identifier_entries DELETE WHERE project_id = #{PROJECT.id} AND segment_id IN (#{ids})") }
  end
  out
end

def own_visitor(identifier, id)
  raise "identifier #{identifier} is not this run's" unless identifier.to_s.match?(IDENTIFIER)

  Visitor.find_by!(project_id: PROJECT.id, sdk_identifier: identifier, id: Integer(id))
end

# The dev stack runs the batch_events worker but not the scheduler that enqueues it each minute; this stands in for that one entry.
def batch_tick
  return if Sidekiq::Queue.new("batch_events").size.positive?
  return if Sidekiq::WorkSet.new.any? { |_, _, work| (work.respond_to?(:job) ? work.job.klass : work.dig("payload", "class")) == "BatchEventProcessorJob" }

  BatchEventProcessorJob.perform_async
end

def handle(request)
  case request["op"]
  when "ping"
    clickhouse = begin
      Clickhouse.with { |conn| conn.select_all("SELECT 1 AS one") }.to_a.first&.fetch("one").to_i == 1
    rescue StandardError
      false
    end
    { ok: true, run: RUN_ID, clickhouse: clickhouse }
  when "populate"
    campaign = own_campaign(request["id"])
    # A busy ClickHouse makes the job re-queue itself for minutes later; here it is retried at once instead.
    10.times do
      break unless campaign.reload.status == "preparing"

      InAppMembershipPopulateJob.new.perform(campaign.id)
      sleep 2 if campaign.reload.status == "preparing"
    end
    drop_jobs("InAppMembershipPopulateJob", "egress_exports") { |args| args.first == campaign.id }
    campaign.reload
    members = campaign.segment_key ? SegmentMembership.where(project_id: PROJECT.id, segment_key: campaign.segment_key).pluck(:visitor_id) : []
    { ok: true, status: campaign.status, failure: campaign.failure_reason, members: members }
  when "purge"
    { ok: true, deleted: purge(request["campaigns"], request["segments"]) }
  when "profile"
    # SyncVisitorProfileJob sits on the default queue, which nothing works here: run it for this run's visitor only.
    visitor = own_visitor(request["identifier"], request["visitor"])
    SyncVisitorProfileJob.new.perform(visitor.id)
    { ok: true }
  when "visitors"
    identifier = request["identifier"].to_s
    raise "identifier #{identifier} is not this run's" unless identifier.match?(IDENTIFIER)

    control = InAppSetting.for(PROJECT).control_group.to_i
    list = Visitor.where(project_id: PROJECT.id, sdk_identifier: identifier).order(:id).map do |v|
      { id: v.id, held: control.positive? && Experiments::Bucket.of(PROJECT.hashid, v.id) < control, profiles: profile_count(v.id, identifier) }
    end
    { ok: true, visitors: list }
  else
    { ok: false, error: "unknown op" }
  end
rescue StandardError => e
  { ok: false, error: "#{e.class}: #{e.message}" }
end

if ENV.fetch("HOST_BATCH_TICK", "1") == "1"
  Thread.new do
    loop do
      begin
        batch_tick
      rescue StandardError => e
        warn "batch tick failed: #{e.class}: #{e.message}"
      end
      sleep 10
    end
  end
end

server = TCPServer.new("127.0.0.1", PORT)
$stdout.puts "host helper listening on #{PORT} for run #{RUN_ID}"
$stdout.flush
loop do
  client = server.accept
  begin
    while (line = client.gets)
      answer = begin
        handle(JSON.parse(line))
      rescue JSON::ParserError
        { ok: false, error: "bad json" }
      end
      client.puts(answer.to_json)
    end
  ensure
    client.close
  end
end
