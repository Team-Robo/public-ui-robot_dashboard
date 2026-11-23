"""A synthetic ROS2 graph that exists purely to exercise the dashboard's
own features - Topics/echo/hz, Services, Actions, Params - without needing
any real robot package running. Not robot behavior, a dev tool that ships
with the dashboard itself: see config/targets.yaml's "debug" category
(sorted last, e-stop-exempt - nothing here can move anything real).

Covers, deliberately spanning several different shapes so each dashboard
feature has something non-trivial to render:
  topics:   /debug/status         std_msgs/String            - plain scalar
            /debug/twist          geometry_msgs/Twist         - nested sub-messages
            /debug/joint_states   sensor_msgs/JointState      - primitive arrays
            /debug/diagnostics    diagnostic_msgs/DiagnosticArray - array of sub-messages
  services: /debug/trigger_test   std_srvs/Trigger            - no request fields
            /debug/set_bool_test  std_srvs/SetBool            - one request field
  action:   /debug/fibonacci      example_interfaces/Fibonacci - goal/feedback/result
  params:   example_bool/int/float/string, plus one read_only=True
"""

import math
import time

import rclpy
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus
from example_interfaces.action import Fibonacci
from geometry_msgs.msg import Twist
from rcl_interfaces.msg import ParameterDescriptor
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import String
from std_srvs.srv import SetBool, Trigger

TICK_PERIOD_SEC = 0.5
STATUS_CYCLE = ["idle", "running", "warning", "ok"]


class DashboardDebugHarness(Node):
    def __init__(self):
        super().__init__("dashboard_debug_harness")

        self.declare_parameter("example_bool", True)
        self.declare_parameter("example_int", 42)
        self.declare_parameter("example_float", 3.14)
        self.declare_parameter("example_string", "hello from the debug harness")
        self.declare_parameter(
            "readonly_example",
            "cant touch this",
            ParameterDescriptor(read_only=True),
        )

        self._status_pub = self.create_publisher(String, "/debug/status", 10)
        self._twist_pub = self.create_publisher(Twist, "/debug/twist", 10)
        self._joint_pub = self.create_publisher(JointState, "/debug/joint_states", 10)
        self._diag_pub = self.create_publisher(DiagnosticArray, "/debug/diagnostics", 10)
        self._tick = 0
        self.create_timer(TICK_PERIOD_SEC, self._on_timer)

        self.create_service(Trigger, "/debug/trigger_test", self._on_trigger)
        self.create_service(SetBool, "/debug/set_bool_test", self._on_set_bool)

        # execute_callback runs in its own thread per goal (ActionServer's
        # default), which is exactly why the feedback loop below can use a
        # plain time.sleep() instead of a timer - it isn't blocking the
        # node's own executor.
        self._action_server = ActionServer(
            self,
            Fibonacci,
            "/debug/fibonacci",
            execute_callback=self._execute_fibonacci,
            goal_callback=self._on_goal,
            cancel_callback=self._on_cancel,
        )

    def _on_timer(self) -> None:
        self._tick += 1
        t = self._tick * TICK_PERIOD_SEC

        self._status_pub.publish(String(data=STATUS_CYCLE[self._tick % len(STATUS_CYCLE)]))

        twist = Twist()
        twist.linear.x = math.sin(t)
        twist.angular.z = math.cos(t * 0.5)
        self._twist_pub.publish(twist)

        joints = JointState()
        joints.name = ["joint1", "joint2", "joint3"]
        joints.position = [math.sin(t), math.sin(t + 1.0), math.sin(t + 2.0)]
        joints.velocity = [math.cos(t), math.cos(t + 1.0), math.cos(t + 2.0)]
        self._joint_pub.publish(joints)

        diag = DiagnosticArray()
        diag.status = [
            DiagnosticStatus(level=DiagnosticStatus.OK, name="debug: sensor A", message="nominal"),
            DiagnosticStatus(level=DiagnosticStatus.WARN, name="debug: sensor B", message="a bit warm"),
        ]
        self._diag_pub.publish(diag)

    @staticmethod
    def _on_trigger(_request: Trigger.Request, response: Trigger.Response) -> Trigger.Response:
        response.success = True
        response.message = "triggered ok"
        return response

    @staticmethod
    def _on_set_bool(request: SetBool.Request, response: SetBool.Response) -> SetBool.Response:
        response.success = True
        response.message = f"set to {request.data}"
        return response

    @staticmethod
    def _on_goal(_goal_request: Fibonacci.Goal) -> GoalResponse:
        return GoalResponse.ACCEPT

    @staticmethod
    def _on_cancel(_goal_handle) -> CancelResponse:
        return CancelResponse.ACCEPT

    @staticmethod
    def _execute_fibonacci(goal_handle) -> Fibonacci.Result:
        order = goal_handle.request.order
        sequence = [0, 1]
        feedback = Fibonacci.Feedback()
        for i in range(1, order):
            if goal_handle.is_cancel_requested:
                goal_handle.canceled()
                result = Fibonacci.Result()
                result.sequence = sequence
                return result
            sequence.append(sequence[i] + sequence[i - 1])
            # Verified against the real installed action, not assumed - this
            # distro's example_interfaces/action/Fibonacci names the
            # feedback field "sequence", same name as Result uses, not the
            # "partial_sequence" some older tutorial versions use.
            feedback.sequence = sequence
            goal_handle.publish_feedback(feedback)
            time.sleep(0.5)
        goal_handle.succeed()
        result = Fibonacci.Result()
        result.sequence = sequence
        return result


def main():
    rclpy.init()
    node = DashboardDebugHarness()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
